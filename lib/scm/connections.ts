/**
 * GitLab and Bitbucket Cloud connections (R3.6): an org admin enters an access token, OpenReview validates it against
 * the host (identity, scopes, expiry), stores it encrypted in `scm_credentials`, and records one `installations` row
 * for it so repositories, reviews, and indexing use the same provider-neutral pipeline as GitHub. Repositories are
 * enabled one at a time; enabling creates the host webhook with a random per-hook secret and queues the first index,
 * disabling removes the webhook. Every query is scoped to the org; the token is never returned.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { BITBUCKET_REQUIRED_SCOPES, bitbucketWebUrl, missingBitbucketScopes, normalizeUuid, type BitbucketApi, type BitbucketHost } from "@/lib/bitbucket/client";
import { decryptSecret, encryptSecret, hashToken, randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { installations, repos, scmCredentials, scmWebhooks } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import type { RemoteRepo } from "@/lib/git/types";
import { GITLAB_REQUIRED_SCOPES, type GitLabApi, type GitLabHost } from "@/lib/gitlab/client";
import { enqueueIndexForNewRepos } from "@/lib/jobs/enqueue";
import type { JobQueue } from "@/lib/jobs/types";
import { assertPublicOrgEndpoint, type HostResolver } from "@/lib/llm/endpoint-guard";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { ScmHttpError } from "./http";

export type ScmProvider = "gitlab" | "bitbucket";

export interface ScmDeps {
  db: Db;
  gitlab: GitLabHost;
  bitbucket: BitbucketHost;
  queue: JobQueue;
  /** Public origin of this app; webhooks point at `<appUrl>/api/webhooks/<provider>`. */
  appUrl: string;
  /** The operator's GitLab instance (`GITLAB_URL`); always allowed, even on a private network. */
  gitlabUrl: string;
  bitbucketApiUrl: string;
  /** DNS resolver for the public-endpoint check of other GitLab URLs (tests inject one). */
  resolve?: HostResolver;
  now?: () => Date;
  log?: Logger;
}

/** A connection problem the admin can fix (bad token, missing scopes, unreachable host); `message` is shown as is. */
export class ScmConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScmConnectError";
  }
}

const tokenField = z.string().trim().min(8, "Enter the access token.").max(4096);

export const gitlabConnectInput = z.object({
  baseUrl: z.string().trim().url("Enter the GitLab URL, e.g. https://gitlab.com.").max(2048),
  token: tokenField,
});

export const bitbucketConnectInput = z.object({
  workspace: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]{1,100}$/, "Enter the workspace ID (the part after bitbucket.org/)."),
  token: tokenField,
  /** Set for an app password / API token (HTTP basic auth); empty for an access token. */
  username: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

const origin = (url: string) => new URL(url).origin;

/**
 * The GitLab origin a connection may use: the operator's `GITLAB_URL` (trusted, may be private), or another public
 * HTTPS instance. Anything else (http, private or loopback addresses) is refused so a token form cannot be turned into
 * a request forgery against internal services.
 */
export async function allowedGitLabUrl(deps: Pick<ScmDeps, "gitlabUrl" | "resolve">, raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScmConnectError("Enter the GitLab URL, e.g. https://gitlab.com.");
  }
  if (url.username || url.password) throw new ScmConnectError("The GitLab URL must not contain credentials.");
  const base = url.origin;
  if (base === origin(deps.gitlabUrl)) return base;
  if (url.protocol !== "https:") throw new ScmConnectError("Use an https:// URL for GitLab.");
  try {
    await assertPublicOrgEndpoint(base, { allowPrivate: false, ...(deps.resolve ? { resolve: deps.resolve } : {}) });
  } catch {
    throw new ScmConnectError(`${url.host} is not reachable as a public GitLab instance. Self-managed GitLab on a private network must be set as GITLAB_URL by the operator.`);
  }
  return base;
}

function hostFailure(err: unknown, what: string): ScmConnectError {
  if (err instanceof ScmConnectError) return err;
  if (err instanceof ScmHttpError) {
    if (err.status === 401) return new ScmConnectError(`${what} rejected the token (401). Check that it is correct, active, and not expired.`);
    if (err.status === 403) return new ScmConnectError(`${what} refused the token (403). It lacks the required scopes or access.`);
    if (err.status === 404) return new ScmConnectError(`${what} could not find that workspace or endpoint (404).`);
    if (err.status === 0) return new ScmConnectError(`${what} could not be reached.`);
    return new ScmConnectError(`${what} answered ${err.status}.`);
  }
  return new ScmConnectError(`${what} could not be checked: ${errorMessage(err)}`);
}

interface GitLabCheck {
  tokenName: string | null;
  scopes: string[];
  missingScopes: string[];
  expiresAt: Date | null;
  accountLogin: string;
  accountId: string;
}

async function checkGitLab(api: GitLabApi): Promise<GitLabCheck> {
  const [token, me] = await Promise.all([api.tokenSelf(), api.currentUser()]);
  if (token.revoked || token.active === false) throw new ScmConnectError("This GitLab token is revoked or expired.");
  return {
    tokenName: token.name ?? null,
    scopes: token.scopes,
    missingScopes: GITLAB_REQUIRED_SCOPES.filter((s) => !token.scopes.includes(s)),
    expiresAt: token.expires_at ? new Date(`${token.expires_at.slice(0, 10)}T23:59:59Z`) : null,
    accountLogin: me.username,
    accountId: String(me.id),
  };
}

interface BitbucketCheck {
  scopes: string[];
  scopesVerified: boolean;
  missingScopes: string[];
  accountLogin: string;
  accountId: string | null;
  workspace: string;
}

async function checkBitbucket(api: BitbucketApi): Promise<BitbucketCheck> {
  const [{ workspace, scopes }, me] = await Promise.all([api.checkWorkspace(), api.currentUser()]);
  return {
    scopes: scopes ?? [],
    scopesVerified: scopes !== null,
    missingScopes: scopes === null ? [] : missingBitbucketScopes(scopes),
    accountLogin: me?.login ?? "",
    accountId: me?.uuid ?? null,
    workspace: workspace.slug,
  };
}

async function insertConnection(
  db: Db,
  values: typeof scmCredentials.$inferInsert,
  installation: { accountLogin: string; accountType: string; webUrl: string },
) {
  return db.transaction(async (tx) => {
    const [cred] = await tx.insert(scmCredentials).values(values).returning();
    const [inst] = await tx
      .insert(installations)
      .values({
        orgId: values.orgId,
        provider: values.provider,
        externalId: cred!.id,
        scmCredentialId: cred!.id,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: "selected",
        webUrl: installation.webUrl,
      })
      .returning();
    return { credentialId: cred!.id, installationId: inst!.id };
  });
}

/** Validates a GitLab token (scopes `api` and `read_repository`) and stores the connection. */
export async function connectGitLab(deps: ScmDeps, input: { orgId: string; userId: string | null; baseUrl: string; token: string }) {
  const parsed = gitlabConnectInput.safeParse(input);
  if (!parsed.success) throw new ScmConnectError(parsed.error.issues[0]?.message ?? "Check the form.");
  const baseUrl = await allowedGitLabUrl(deps, parsed.data.baseUrl);
  let check: GitLabCheck;
  try {
    check = await checkGitLab(deps.gitlab.apiFor({ baseUrl, token: parsed.data.token }));
  } catch (err) {
    throw hostFailure(err, "GitLab");
  }
  if (check.missingScopes.length) throw new ScmConnectError(`The token is missing the ${check.missingScopes.join(", ")} scope${check.missingScopes.length > 1 ? "s" : ""}.`);
  const now = (deps.now ?? (() => new Date()))();
  const created = await insertConnection(
    deps.db,
    {
      orgId: input.orgId,
      provider: "gitlab",
      baseUrl,
      authKind: "token",
      tokenEnc: encryptSecret(parsed.data.token),
      tokenName: check.tokenName,
      scopes: check.scopes,
      missingScopes: [],
      scopesVerified: true,
      accountLogin: check.accountLogin,
      accountId: check.accountId,
      expiresAt: check.expiresAt,
      lastCheckedAt: now,
      createdBy: input.userId,
    },
    { accountLogin: check.tokenName ? `${new URL(baseUrl).host} · ${check.tokenName}` : new URL(baseUrl).host, accountType: "GitLab", webUrl: baseUrl },
  );
  (deps.log ?? rootLog).info("gitlab connected", { orgId: input.orgId, credentialId: created.credentialId, host: new URL(baseUrl).host });
  return created;
}

/** Validates a Bitbucket workspace credential and stores the connection. */
export async function connectBitbucket(deps: ScmDeps, input: { orgId: string; userId: string | null; workspace: string; token: string; username?: string }) {
  const parsed = bitbucketConnectInput.safeParse(input);
  if (!parsed.success) throw new ScmConnectError(parsed.error.issues[0]?.message ?? "Check the form.");
  const { workspace, token, username } = parsed.data;
  const apiUrl = deps.bitbucketApiUrl.replace(/\/+$/, "");
  let check: BitbucketCheck;
  try {
    check = await checkBitbucket(deps.bitbucket.apiFor({ apiUrl, workspace, token, ...(username ? { username } : {}) }));
  } catch (err) {
    throw hostFailure(err, "Bitbucket");
  }
  if (check.missingScopes.length) throw new ScmConnectError(`The credential is missing the ${check.missingScopes.join(", ")} scope${check.missingScopes.length > 1 ? "s" : ""}.`);
  const now = (deps.now ?? (() => new Date()))();
  const created = await insertConnection(
    deps.db,
    {
      orgId: input.orgId,
      provider: "bitbucket",
      baseUrl: apiUrl,
      workspace: check.workspace,
      authKind: username ? "app_password" : "token",
      username: username ?? null,
      tokenEnc: encryptSecret(token),
      scopes: check.scopes,
      missingScopes: [],
      scopesVerified: check.scopesVerified,
      accountLogin: check.accountLogin,
      accountId: check.accountId,
      lastCheckedAt: now,
      createdBy: input.userId,
    },
    { accountLogin: check.workspace, accountType: "Workspace", webUrl: bitbucketWebUrl(apiUrl) },
  );
  (deps.log ?? rootLog).info("bitbucket connected", { orgId: input.orgId, credentialId: created.credentialId, workspace: check.workspace });
  return created;
}

export type ConnectionStatus = "ok" | "missing_scopes" | "expiring" | "expired" | "invalid";

/** Days before expiry from which a connection shows as expiring. */
export const EXPIRY_WARNING_DAYS = 14;

/** The org's GitLab / Bitbucket connections with health, never the token. */
export async function listConnections(db: Db, orgId: string, now: Date = new Date()) {
  const rows = await db
    .select({ cred: scmCredentials, installationId: installations.id })
    .from(scmCredentials)
    .leftJoin(installations, and(eq(installations.scmCredentialId, scmCredentials.id), eq(installations.orgId, orgId)))
    .where(scoped(scmCredentials, orgId))
    .orderBy(scmCredentials.provider, scmCredentials.id);
  const ids = rows.map((r) => r.installationId).filter((id): id is number => id !== null);
  const repoRows = ids.length
    ? await db.select({ installationId: repos.installationId, enabled: repos.enabled }).from(repos).where(scoped(repos, orgId, inArray(repos.installationId, ids)))
    : [];
  return rows.map(({ cred, installationId }) => {
    const expired = cred.expiresAt !== null && cred.expiresAt.getTime() <= now.getTime();
    const expiring = !expired && cred.expiresAt !== null && cred.expiresAt.getTime() - now.getTime() < EXPIRY_WARNING_DAYS * 86_400_000;
    const status: ConnectionStatus = cred.lastError ? "invalid" : expired ? "expired" : cred.missingScopes.length ? "missing_scopes" : expiring ? "expiring" : "ok";
    return {
      id: cred.id,
      provider: cred.provider as ScmProvider,
      installationId,
      baseUrl: cred.baseUrl,
      workspace: cred.workspace,
      authKind: cred.authKind,
      username: cred.username,
      tokenName: cred.tokenName,
      scopes: cred.scopes,
      scopesVerified: cred.scopesVerified,
      missingScopes: cred.missingScopes,
      accountLogin: cred.accountLogin,
      expiresAt: cred.expiresAt,
      lastCheckedAt: cred.lastCheckedAt,
      lastError: cred.lastError,
      enabledRepos: repoRows.filter((r) => r.installationId === installationId && r.enabled).length,
      status,
    };
  });
}

export type ConnectionView = Awaited<ReturnType<typeof listConnections>>[number];

async function getCredential(db: Db, orgId: string, credentialId: number) {
  const [row] = await db.select().from(scmCredentials).where(scoped(scmCredentials, orgId, eq(scmCredentials.id, credentialId)));
  return row;
}

async function installationOf(db: Db, orgId: string, credentialId: number) {
  const [row] = await db.select().from(installations).where(scoped(installations, orgId, eq(installations.scmCredentialId, credentialId)));
  return row;
}

function gitlabApi(deps: ScmDeps, cred: typeof scmCredentials.$inferSelect): GitLabApi {
  return deps.gitlab.apiFor({ baseUrl: cred.baseUrl, token: decryptSecret(cred.tokenEnc) });
}

function bitbucketApi(deps: ScmDeps, cred: typeof scmCredentials.$inferSelect): BitbucketApi {
  return deps.bitbucket.apiFor({
    apiUrl: cred.baseUrl,
    workspace: cred.workspace ?? "",
    token: decryptSecret(cred.tokenEnc),
    ...(cred.authKind === "app_password" && cred.username ? { username: cred.username } : {}),
  });
}

/** Re-validates a connection against its host and records the result (token validity, scopes, expiry). */
export async function checkConnection(deps: ScmDeps, orgId: string, credentialId: number) {
  const cred = await getCredential(deps.db, orgId, credentialId);
  if (!cred) return undefined;
  const now = (deps.now ?? (() => new Date()))();
  let patch: Partial<typeof scmCredentials.$inferInsert>;
  try {
    if (cred.provider === "gitlab") {
      const c = await checkGitLab(gitlabApi(deps, cred));
      patch = { tokenName: c.tokenName, scopes: c.scopes, missingScopes: c.missingScopes, expiresAt: c.expiresAt, accountLogin: c.accountLogin, accountId: c.accountId };
    } else {
      const c = await checkBitbucket(bitbucketApi(deps, cred));
      patch = { scopes: c.scopes, scopesVerified: c.scopesVerified, missingScopes: c.missingScopes, ...(c.accountId ? { accountLogin: c.accountLogin, accountId: c.accountId } : {}) };
    }
    patch.lastError = null;
  } catch (err) {
    patch = { lastError: hostFailure(err, cred.provider === "gitlab" ? "GitLab" : "Bitbucket").message };
  }
  await deps.db
    .update(scmCredentials)
    .set({ ...patch, lastCheckedAt: now })
    .where(scoped(scmCredentials, orgId, eq(scmCredentials.id, credentialId)));
  return (await listConnections(deps.db, orgId, now)).find((c) => c.id === credentialId);
}

async function deleteRemoteHook(deps: ScmDeps, cred: typeof scmCredentials.$inferSelect, hook: { externalHookId: string }, repo: { externalId: number; fullName: string }) {
  if (cred.provider === "gitlab") await gitlabApi(deps, cred).deleteHook(repo.externalId, Number(hook.externalHookId));
  else await bitbucketApi(deps, cred).deleteHook(repo.fullName, hook.externalHookId);
}

/**
 * Disconnects a provider: removes every webhook OpenReview created with it (best effort: a revoked token cannot, and
 * the host then stops delivering anyway), then deletes the credential, its installation, and by cascade its
 * repositories and their reviews and index.
 */
export async function disconnectConnection(deps: ScmDeps, orgId: string, credentialId: number): Promise<boolean> {
  const cred = await getCredential(deps.db, orgId, credentialId);
  if (!cred) return false;
  const log = (deps.log ?? rootLog).child({ orgId, credentialId, provider: cred.provider });
  const hooks = await deps.db
    .select({ hook: scmWebhooks, repo: repos })
    .from(scmWebhooks)
    .innerJoin(repos, eq(repos.id, scmWebhooks.repoId))
    .where(scoped(scmWebhooks, orgId, eq(scmWebhooks.credentialId, credentialId)));
  for (const { hook, repo } of hooks) {
    try {
      await deleteRemoteHook(deps, cred, hook, repo);
    } catch (err) {
      log.warn("could not remove a webhook while disconnecting", { repo: repo.fullName, error: errorMessage(err) });
    }
  }
  await deps.db.delete(scmCredentials).where(scoped(scmCredentials, orgId, eq(scmCredentials.id, credentialId)));
  log.info("provider disconnected", { hooks: hooks.length });
  return true;
}

/** Repositories the connection can reach, each with whether OpenReview reviews it. */
export async function listConnectionRepos(deps: ScmDeps, orgId: string, credentialId: number) {
  const cred = await getCredential(deps.db, orgId, credentialId);
  if (!cred) return undefined;
  const inst = await installationOf(deps.db, orgId, credentialId);
  const remote: RemoteRepo[] = cred.provider === "gitlab" ? await gitlabApi(deps, cred).listProjects() : await bitbucketApi(deps, cred).listRepositories();
  const local = inst ? await deps.db.select().from(repos).where(scoped(repos, orgId, eq(repos.installationId, inst.id))) : [];
  const byExternal = new Map(local.map((r) => [r.externalId, r]));
  return remote.map((r) => {
    const row = byExternal.get(r.id);
    return { ...r, repoId: row?.id ?? null, enabled: Boolean(row?.enabled) };
  });
}

/** The webhook endpoint for a provider on this app. */
export function webhookUrl(appUrl: string, provider: ScmProvider): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/${provider}`;
}

/**
 * Enables reviews for one repository of a connection: records it, creates the host webhook (merge request / pull
 * request, comment, and push events) with a fresh random secret, and queues its first index. Enabling an already
 * enabled repository replaces its webhook.
 */
export async function enableConnectionRepo(deps: ScmDeps, orgId: string, credentialId: number, externalRepoId: number) {
  const cred = await getCredential(deps.db, orgId, credentialId);
  const inst = cred ? await installationOf(deps.db, orgId, credentialId) : undefined;
  if (!cred || !inst) return undefined;
  const provider = cred.provider as ScmProvider;
  // The repository must be one the token can reach: never trust the submitted id alone.
  const remote = (provider === "gitlab" ? await gitlabApi(deps, cred).listProjects() : await bitbucketApi(deps, cred).listRepositories()).find(
    (r) => r.id === externalRepoId,
  );
  if (!remote) throw new ScmConnectError("That repository isn't reachable with this connection's token.");

  const [repo] = await deps.db
    .insert(repos)
    .values({
      orgId,
      installationId: inst.id,
      externalId: remote.id,
      fullName: remote.fullName,
      defaultBranch: remote.defaultBranch,
      private: remote.private,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [repos.installationId, repos.externalId],
      set: { fullName: remote.fullName, defaultBranch: remote.defaultBranch, private: remote.private, enabled: true, archived: false },
    })
    .returning();
  await removeRepoHook(deps, orgId, repo!.id);

  const secret = randomToken(32);
  const url = webhookUrl(deps.appUrl, provider);
  const externalHookId =
    provider === "gitlab" ? String((await gitlabApi(deps, cred).createHook(remote.id, url, secret)).id) : normalizeUuid((await bitbucketApi(deps, cred).createHook(remote.fullName, url, secret)).uuid);
  await deps.db.insert(scmWebhooks).values({
    orgId,
    repoId: repo!.id,
    credentialId,
    provider,
    externalHookId,
    secretHash: hashToken(secret),
    secretEnc: encryptSecret(secret),
  });
  const jobs = await enqueueIndexForNewRepos([repo!], deps.queue);
  (deps.log ?? rootLog).info("repository enabled", { orgId, repoId: repo!.id, provider, jobs });
  return repo!;
}

/** Deletes a repository's webhook on the host and its record (no-op when it has none). */
async function removeRepoHook(deps: ScmDeps, orgId: string, repoId: number) {
  const [row] = await deps.db
    .select({ hook: scmWebhooks, repo: repos, cred: scmCredentials })
    .from(scmWebhooks)
    .innerJoin(repos, eq(repos.id, scmWebhooks.repoId))
    .innerJoin(scmCredentials, eq(scmCredentials.id, scmWebhooks.credentialId))
    .where(scoped(scmWebhooks, orgId, eq(scmWebhooks.repoId, repoId)));
  if (!row) return false;
  await deleteRemoteHook(deps, row.cred, row.hook, row.repo);
  await deps.db.delete(scmWebhooks).where(scoped(scmWebhooks, orgId, eq(scmWebhooks.id, row.hook.id)));
  return true;
}

/** Pauses reviews for a GitLab / Bitbucket repository and removes its webhook; its index and history are kept. */
export async function disableConnectionRepo(deps: ScmDeps, orgId: string, repoId: number): Promise<boolean> {
  const [row] = await deps.db.select({ id: repos.id }).from(repos).where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!row) return false;
  await removeRepoHook(deps, orgId, repoId);
  await deps.db.update(repos).set({ enabled: false }).where(scoped(repos, orgId, eq(repos.id, repoId)));
  return true;
}

export { BITBUCKET_REQUIRED_SCOPES, GITLAB_REQUIRED_SCOPES };
