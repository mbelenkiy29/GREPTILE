import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { installations, orgs, pendingInstallations, repos, type RepoSettings } from "@/lib/db/schema";
import { repoSettingsSchema } from "@/lib/config/settings";
import type { GitHost, RemoteInstallation, RemoteRepo } from "@/lib/git/types";
import { log } from "@/lib/log";
import { scoped } from "./tenant";

export class InstallationOwnershipError extends Error {}
export class PendingInstallationNotFoundError extends Error {}

type InstallationRow = typeof installations.$inferSelect;
type RepoRow = typeof repos.$inferSelect;

/** Permissions OpenReview cannot work without, and ones that unlock extra context (R1.1). */
export const REQUIRED_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "write",
};
export const RECOMMENDED_PERMISSIONS: Readonly<Record<string, "read" | "write">> = { checks: "read" };

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Entries of `wanted` that `granted` does not satisfy, as `name:level` (e.g. `pull_requests:write`). */
export function missingPermissions(granted: Record<string, string>, wanted: Readonly<Record<string, string>> = REQUIRED_PERMISSIONS): string[] {
  return Object.entries(wanted)
    .filter(([name, level]) => (LEVEL[granted[name] ?? ""] ?? 0) < (LEVEL[level] ?? 1))
    .map(([name, level]) => `${name}:${level}`);
}

/** Columns describing what GitHub reports about an installation; permission columns only when it reported them. */
function remoteColumns(remote: Pick<RemoteInstallation, "accountType" | "permissions" | "repositorySelection">) {
  return {
    ...(remote.accountType ? { accountType: remote.accountType } : {}),
    ...(remote.repositorySelection ? { repositorySelection: remote.repositorySelection } : {}),
    ...(remote.permissions ? { permissions: remote.permissions, missingPermissions: missingPermissions(remote.permissions) } : {}),
  };
}

function warnIfMissing(installation: { id: number; orgId: string; externalId: number; missingPermissions: string[] }) {
  if (installation.missingPermissions.length) {
    log.warn("installation is missing required permissions", {
      orgId: installation.orgId,
      installationId: installation.externalId,
      missing: installation.missingPermissions,
    });
  }
}

export async function ensureOrg(db: Db, orgId: string, name: string) {
  await db.insert(orgs).values({ id: orgId, name }).onConflictDoUpdate({ target: orgs.id, set: { name } });
}

/**
 * Completes the GitHub App install flow for an org (R1.1): records the installation under the org with the
 * permissions GitHub reports, syncs the repositories the user selected, and drops any pending (unclaimed) record of
 * it. An installation already linked to a different org cannot be claimed. The caller verifies the user's access.
 */
export async function completeInstallation(
  db: Db,
  host: GitHost,
  input: { orgId: string; orgName: string; installationId: number },
) {
  const remote = await host.getInstallation(input.installationId);
  await ensureOrg(db, input.orgId, input.orgName);

  const existing = await findInstallationByExternalId(db, host.provider, remote.id);
  if (existing && existing.orgId !== input.orgId) {
    throw new InstallationOwnershipError("This installation is already connected to another organization.");
  }

  const columns = remoteColumns(remote);
  const [row] = await db
    .insert(installations)
    .values({ orgId: input.orgId, provider: host.provider, externalId: remote.id, accountLogin: remote.accountLogin, ...columns })
    .onConflictDoUpdate({
      target: [installations.provider, installations.externalId],
      set: { accountLogin: remote.accountLogin, suspended: false, ...columns },
    })
    .returning();
  // Another org may have linked it between the check and the upsert; the upsert never changes the owner.
  if (row!.orgId !== input.orgId) {
    throw new InstallationOwnershipError("This installation is already connected to another organization.");
  }
  await deletePendingInstallation(db, host.provider, remote.id);
  warnIfMissing(row!);

  const synced = await syncInstallationRepos(db, host, row!);
  return { installation: row!, repos: synced, missingPermissions: row!.missingPermissions };
}

/**
 * Links an installation that arrived by webhook before anyone claimed it (R1.1). Reuses `completeInstallation`
 * (which deletes the pending row); claiming an installation the same org already linked is a no-op refresh. The
 * caller must first verify that the signed-in user can access the installation on GitHub.
 */
export async function claimPendingInstallation(
  db: Db,
  host: GitHost,
  input: { orgId: string; orgName: string; installationId: number },
) {
  const pending = await getPendingInstallation(db, host.provider, input.installationId);
  if (!pending) {
    const linked = await findInstallationByExternalId(db, host.provider, input.installationId);
    if (!linked) throw new PendingInstallationNotFoundError("No unclaimed installation with that id.");
    if (linked.orgId !== input.orgId) {
      throw new InstallationOwnershipError("This installation is already connected to another organization.");
    }
  }
  return completeInstallation(db, host, input);
}

export interface PendingInstallationInput {
  externalId: number;
  accountLogin: string;
  accountType: string;
  senderLogin: string;
  senderId?: number;
  permissions?: Record<string, string>;
  repositorySelection?: string;
}

/**
 * Records an installation no org has linked yet (from `installation.created`). If the install callback links it
 * concurrently, whichever finishes last removes the pending row, so a linked installation never stays pending.
 */
export async function storePendingInstallation(db: Db, provider: string, input: PendingInstallationInput) {
  const values = {
    provider,
    externalId: input.externalId,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    senderLogin: input.senderLogin,
    senderId: input.senderId ?? null,
    permissions: input.permissions ?? {},
    repositorySelection: input.repositorySelection ?? null,
  };
  const [row] = await db
    .insert(pendingInstallations)
    .values(values)
    .onConflictDoUpdate({ target: [pendingInstallations.provider, pendingInstallations.externalId], set: values })
    .returning();
  if (await findInstallationByExternalId(db, provider, input.externalId)) {
    await deletePendingInstallation(db, provider, input.externalId);
    return undefined;
  }
  return row;
}

export async function getPendingInstallation(db: Db, provider: string, externalId: number) {
  const [row] = await db
    .select()
    .from(pendingInstallations)
    .where(and(eq(pendingInstallations.provider, provider), eq(pendingInstallations.externalId, externalId)));
  return row;
}

/**
 * Unclaimed installations among `externalIds` (e.g. the installations GitHub says the signed-in user can access),
 * oldest first. Installations already linked to an org are never returned.
 */
export async function listPendingInstallations(db: Db, externalIds: number[], provider = "github") {
  if (!externalIds.length) return [];
  const rows = await db
    .select()
    .from(pendingInstallations)
    .where(and(eq(pendingInstallations.provider, provider), inArray(pendingInstallations.externalId, externalIds)))
    .orderBy(pendingInstallations.createdAt);
  const linked = await db
    .select({ externalId: installations.externalId })
    .from(installations)
    .where(and(eq(installations.provider, provider), inArray(installations.externalId, externalIds)));
  const linkedIds = new Set(linked.map((l) => l.externalId));
  return rows.filter((r) => !linkedIds.has(r.externalId));
}

export async function deletePendingInstallation(db: Db, provider: string, externalId: number) {
  const rows = await db
    .delete(pendingInstallations)
    .where(and(eq(pendingInstallations.provider, provider), eq(pendingInstallations.externalId, externalId)))
    .returning({ id: pendingInstallations.id });
  return rows.length > 0;
}

/** Updates the permissions recorded for a pending installation (`new_permissions_accepted` before it is claimed). */
export async function updatePendingPermissions(db: Db, provider: string, externalId: number, permissions: Record<string, string>) {
  const rows = await db
    .update(pendingInstallations)
    .set({ permissions })
    .where(and(eq(pendingInstallations.provider, provider), eq(pendingInstallations.externalId, externalId)))
    .returning({ id: pendingInstallations.id });
  return rows.length > 0;
}

/**
 * Re-validates an installation's permissions (R1.1) from what a webhook reported, or from the host when the
 * webhook did not include them. Returns the updated row.
 */
export async function refreshInstallationPermissions(
  db: Db,
  host: GitHost,
  installation: { id: number; orgId: string; externalId: number },
  reported?: Pick<RemoteInstallation, "accountType" | "permissions" | "repositorySelection">,
) {
  const remote = reported?.permissions ? reported : await host.getInstallation(installation.externalId);
  const where = scoped(installations, installation.orgId, eq(installations.id, installation.id));
  const set = remoteColumns(remote);
  if (!Object.keys(set).length) {
    const [unchanged] = await db.select().from(installations).where(where);
    return unchanged;
  }
  const [row] = await db.update(installations).set(set).where(where).returning();
  if (row) warnIfMissing(row);
  return row;
}

/** Updates what GitHub reports about a linked installation (account type, repository selection) without a fetch. */
export async function updateInstallationDetails(
  db: Db,
  installation: { id: number; orgId: string },
  details: Pick<RemoteInstallation, "accountType" | "repositorySelection">,
) {
  const set = remoteColumns(details);
  if (!Object.keys(set).length) return;
  await db.update(installations).set(set).where(scoped(installations, installation.orgId, eq(installations.id, installation.id)));
}

export async function setInstallationSuspended(db: Db, installation: { id: number; orgId: string }, suspended: boolean) {
  await db.update(installations).set({ suspended }).where(scoped(installations, installation.orgId, eq(installations.id, installation.id)));
}

/** Removes an uninstalled installation and, by cascade, its repositories and their data. */
export async function deleteInstallation(db: Db, installation: { id: number; orgId: string }) {
  await db.delete(installations).where(scoped(installations, installation.orgId, eq(installations.id, installation.id)));
}

export type InstallationStatus = "ok" | "missing_permissions" | "suspended";

/** Per-installation health for the dashboard and onboarding (R1.1): suspension and missing permissions. */
export async function getInstallationHealth(db: Db, orgId: string) {
  const rows = await db.select().from(installations).where(scoped(installations, orgId)).orderBy(installations.accountLogin);
  return rows.map((i) => {
    const verified = Object.keys(i.permissions).length > 0;
    const status: InstallationStatus = i.suspended ? "suspended" : i.missingPermissions.length ? "missing_permissions" : "ok";
    return {
      id: i.id,
      externalId: i.externalId,
      accountLogin: i.accountLogin,
      accountType: i.accountType,
      repositorySelection: i.repositorySelection,
      suspended: i.suspended,
      permissions: i.permissions,
      /** False for installations linked before permissions were recorded. */
      permissionsVerified: verified,
      missingPermissions: i.missingPermissions,
      missingRecommended: verified ? missingPermissions(i.permissions, RECOMMENDED_PERMISSIONS) : [],
      status,
    };
  });
}

/** Mirrors the installation's repository selection into `repos` (adds new, removes deselected). */
export async function syncInstallationRepos(
  db: Db,
  host: GitHost,
  installation: { id: number; orgId: string; externalId: number },
  remoteRepos?: RemoteRepo[],
) {
  const list = remoteRepos ?? (await host.listInstallationRepos(installation.externalId));
  for (const r of list) {
    const archived = r.archived === undefined ? {} : r.archived ? { archived: true, enabled: false } : { archived: false };
    await db
      .insert(repos)
      .values({
        orgId: installation.orgId,
        installationId: installation.id,
        externalId: r.id,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        private: r.private,
        ...archived,
      })
      .onConflictDoUpdate({
        target: [repos.installationId, repos.externalId],
        set: { fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private, ...archived },
      });
  }
  const keep = list.map((r) => r.id);
  await db
    .delete(repos)
    .where(
      scoped(
        repos,
        installation.orgId,
        eq(repos.installationId, installation.id),
        keep.length ? notInArray(repos.externalId, keep) : undefined,
      ),
    );
  return listRepos(db, installation.orgId, installation.id);
}

export async function findInstallationByExternalId(db: Db, provider: string, externalId: number): Promise<InstallationRow | undefined> {
  const [row] = await db
    .select()
    .from(installations)
    .where(and(eq(installations.provider, provider), eq(installations.externalId, externalId)));
  return row;
}

export async function listInstallations(db: Db, orgId: string) {
  return db.select().from(installations).where(scoped(installations, orgId));
}

export async function listRepos(db: Db, orgId: string, installationId?: number) {
  return db
    .select()
    .from(repos)
    .where(scoped(repos, orgId, installationId ? eq(repos.installationId, installationId) : undefined))
    .orderBy(repos.fullName);
}

export async function getRepo(db: Db, orgId: string, repoId: number) {
  const [row] = await db.select().from(repos).where(scoped(repos, orgId, eq(repos.id, repoId)));
  return row;
}

/** A repository of one installation by the host's repository id. */
export async function findInstallationRepo(db: Db, installation: { id: number; orgId: string }, externalRepoId: number): Promise<RepoRow | undefined> {
  const [row] = await db
    .select()
    .from(repos)
    .where(scoped(repos, installation.orgId, eq(repos.installationId, installation.id), eq(repos.externalId, externalRepoId)));
  return row;
}

export type RepoEventPatch = Partial<Pick<RepoRow, "fullName" | "defaultBranch" | "private" | "archived" | "enabled">>;

/** Applies a change GitHub reported for a repository (rename, transfer, archive, visibility, default branch). */
export async function updateInstallationRepo(
  db: Db,
  installation: { id: number; orgId: string },
  externalRepoId: number,
  patch: RepoEventPatch,
): Promise<RepoRow | undefined> {
  const [row] = await db
    .update(repos)
    .set(patch)
    .where(scoped(repos, installation.orgId, eq(repos.installationId, installation.id), eq(repos.externalId, externalRepoId)))
    .returning();
  return row;
}

/** Deletes a repository GitHub reported deleted, with its index, reviews, and learned data (by cascade). */
export async function deleteInstallationRepo(db: Db, installation: { id: number; orgId: string }, externalRepoId: number) {
  const rows = await db
    .delete(repos)
    .where(scoped(repos, installation.orgId, eq(repos.installationId, installation.id), eq(repos.externalId, externalRepoId)))
    .returning({ id: repos.id, fullName: repos.fullName });
  return rows[0];
}

/** Turns reviews on or off for one of the org's repos. Returns false if the repo is not the org's. */
export async function setRepoEnabled(db: Db, orgId: string, repoId: number, enabled: boolean) {
  const rows = await db
    .update(repos)
    .set({ enabled })
    .where(scoped(repos, orgId, eq(repos.id, repoId)))
    .returning({ id: repos.id });
  return rows.length > 0;
}

/** Validated partial update of a repo's dashboard review settings (R2.2). */
export async function updateRepoSettings(db: Db, orgId: string, repoId: number, settings: RepoSettings) {
  const parsed = repoSettingsSchema.parse(settings);
  const rows = await db
    .update(repos)
    .set({ settings: parsed })
    .where(scoped(repos, orgId, eq(repos.id, repoId)))
    .returning({ settings: repos.settings });
  return rows[0]?.settings;
}
