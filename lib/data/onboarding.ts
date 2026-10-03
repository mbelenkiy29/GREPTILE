/**
 * The onboarding wizard (R6.2): sign in → workspace → install the GitHub App → select repositories → review
 * defaults → indexing → ready. Progress is derived from the org's data (installations, enabled repositories, org
 * settings, index state); only finishing the wizard is stored (`orgs.onboardingCompletedAt`). Every function is
 * tenant-scoped by the org id taken from the session.
 */
import { and, count, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { can, type Role } from "@/lib/auth/permissions";
import { clearUserGitHubToken, getUserGitHubToken, GitHubUserTokenError, listUserInstallations, type GitHubUserDeps } from "@/lib/auth/github-user";
import { authorizeRequest } from "@/lib/auth/request";
import type { SessionClock } from "@/lib/auth/sessions";
import type { Db } from "@/lib/db";
import { installations, orgs, pendingInstallations, repos } from "@/lib/db/schema";
import type { GitHost } from "@/lib/git/types";
import { getIndexStatus, type IndexStatus } from "@/lib/indexer/jobs";
import type { JobQueue } from "@/lib/jobs/types";
import { errorMessage, log } from "@/lib/log";
import { UsageLimitError } from "@/lib/billing/limits";
import { requestReview, ReviewRequestError } from "@/lib/pipeline/request";
import { claimPendingInstallation, InstallationOwnershipError, listPendingInstallations, PendingInstallationNotFoundError } from "./installations";
import { scoped } from "./tenant";

export const ONBOARDING_STEPS = ["workspace", "install", "repos", "configure", "indexing", "ready"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_LABEL: Record<OnboardingStep, string> = {
  workspace: "Workspace",
  install: "Connect your git host",
  repos: "Select repositories",
  configure: "Review behavior",
  indexing: "Indexing",
  ready: "Ready",
};

/** Steps only owners and admins can complete; members see a read-only explanation. */
export const ADMIN_STEPS: ReadonlySet<OnboardingStep> = new Set(["install", "repos", "configure"]);

/** What the wizard's progress is derived from. */
export interface OnboardingFacts {
  /** The session has an active org the user belongs to. */
  hasOrg: boolean;
  installations: number;
  repos: number;
  enabledRepos: number;
  /** Enabled, non-archived repositories whose index is ready. */
  indexedRepos: number;
  /** The org has saved review defaults. */
  configured: boolean;
  completedAt: Date | null;
}

export interface OnboardingState extends OnboardingFacts {
  steps: { id: OnboardingStep; label: string; done: boolean }[];
  /** The first step that is not done (where the wizard resumes), or `ready` when everything is. */
  current: OnboardingStep;
}

/** Which steps are done, and where the wizard resumes (R6.2). */
export function deriveOnboarding(facts: OnboardingFacts): OnboardingState {
  const done: Record<OnboardingStep, boolean> = {
    workspace: facts.hasOrg,
    install: facts.hasOrg && facts.installations > 0,
    repos: facts.hasOrg && facts.enabledRepos > 0,
    configure: facts.hasOrg && facts.configured,
    indexing: facts.hasOrg && facts.enabledRepos > 0 && facts.indexedRepos >= facts.enabledRepos,
    ready: facts.hasOrg && facts.completedAt !== null,
  };
  const current = ONBOARDING_STEPS.find((s) => !done[s]) ?? "ready";
  return { ...facts, steps: ONBOARDING_STEPS.map((id) => ({ id, label: ONBOARDING_STEP_LABEL[id], done: done[id] })), current };
}

/**
 * Whether the wizard may show `step`: any finished step, every step up to where it resumes, and "ready" while
 * indexing is still running (indexing never blocks finishing onboarding). Without a workspace only step 1.
 */
export function canViewStep(state: OnboardingState, step: OnboardingStep): boolean {
  if (!state.hasOrg) return step === "workspace";
  if (state.steps.find((s) => s.id === step)?.done) return true;
  const at = ONBOARDING_STEPS.indexOf(state.current);
  return ONBOARDING_STEPS.indexOf(step) <= at || (state.current === "indexing" && step === "ready");
}

/** The onboarding facts of an org (or of a user without an active org). */
export async function getOnboardingState(db: Db, orgId: string | null): Promise<OnboardingState> {
  if (!orgId) {
    return deriveOnboarding({ hasOrg: false, installations: 0, repos: 0, enabledRepos: 0, indexedRepos: 0, configured: false, completedAt: null });
  }
  const [[org], [inst], repoRows] = await Promise.all([
    db.select({ settings: orgs.settings, completedAt: orgs.onboardingCompletedAt }).from(orgs).where(eq(orgs.id, orgId)),
    db.select({ n: count() }).from(installations).where(scoped(installations, orgId)),
    db
      .select({ enabled: repos.enabled, archived: repos.archived, indexStatus: repos.indexStatus })
      .from(repos)
      .where(scoped(repos, orgId)),
  ]);
  const active = repoRows.filter((r) => r.enabled && !r.archived);
  return deriveOnboarding({
    hasOrg: org !== undefined,
    installations: Number(inst?.n ?? 0),
    repos: repoRows.length,
    enabledRepos: active.length,
    indexedRepos: active.filter((r) => r.indexStatus === "ready").length,
    configured: Object.keys(org?.settings ?? {}).length > 0,
    completedAt: org?.completedAt ?? null,
  });
}

/** Whether sign-in should land on the wizard: the org has no GitHub installation and never finished onboarding. */
export async function needsOnboarding(db: Db, orgId: string | null): Promise<boolean> {
  if (!orgId) return true;
  const [org] = await db.select({ completedAt: orgs.onboardingCompletedAt }).from(orgs).where(eq(orgs.id, orgId));
  if (!org || org.completedAt) return false;
  const [inst] = await db.select({ n: count() }).from(installations).where(scoped(installations, orgId));
  return Number(inst?.n ?? 0) === 0;
}

/** Marks onboarding finished for the org (the "Ready" step). */
export async function completeOnboarding(db: Db, orgId: string, now: Date = new Date()): Promise<void> {
  if (!orgId) throw new Error("tenant scope requires an orgId");
  await db.update(orgs).set({ onboardingCompletedAt: now }).where(eq(orgs.id, orgId));
}

// ---- GitHub: pending installations ------------------------------------------------------------------------------

export type PendingInstallationRow = typeof pendingInstallations.$inferSelect;

export type ClaimableResult =
  | { status: "ok"; installations: PendingInstallationRow[] }
  /** No usable GitHub user token: the user must sign in with GitHub again. */
  | { status: "reauthorize" }
  | { status: "github_unavailable" };

export interface GitHubAccessDeps extends GitHubUserDeps {
  db: Db;
  now?: Date;
}

/**
 * Installations of the GitHub App that arrived by webhook before any org claimed them AND that the signed-in user
 * can access according to GitHub (`GET /user/installations` with their own token). Nobody else's installation is
 * ever offered.
 */
export async function listClaimableInstallations(deps: GitHubAccessDeps, userId: string): Promise<ClaimableResult> {
  const token = await getUserGitHubToken(deps.db, userId, deps.now);
  if (!token) return { status: "reauthorize" };
  try {
    const visible = await listUserInstallations(token, deps);
    return { status: "ok", installations: await listPendingInstallations(deps.db, visible.map((i) => i.id)) };
  } catch (err) {
    if (err instanceof GitHubUserTokenError) {
      await clearUserGitHubToken(deps.db, userId);
      return { status: "reauthorize" };
    }
    log.warn("could not list the user's GitHub installations", { userId, error: errorMessage(err) });
    return { status: "github_unavailable" };
  }
}

export type ConnectOutcome =
  | { status: "connected"; repos: number; missingPermissions: string[] }
  | { status: "forbidden" | "reauthorize" | "not_accessible" | "not_found" | "owned_elsewhere" | "github_unavailable" };

/**
 * "Connect existing installation" (R6.2, R1.1): links a pending installation to the caller's org, but only after
 * GitHub confirms the signed-in user can access it, and only for owners and admins. Newly connected repositories
 * are queued for indexing.
 */
export async function connectPendingInstallation(
  deps: GitHubAccessDeps & { host: GitHost; enqueue: (rows: (typeof repos.$inferSelect)[]) => Promise<unknown> },
  ctx: { orgId: string; orgName: string; userId: string; role: Role },
  installationId: number,
): Promise<ConnectOutcome> {
  if (!can(ctx.role, "repos.manage")) return { status: "forbidden" };
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return { status: "not_found" };
  const token = await getUserGitHubToken(deps.db, ctx.userId, deps.now);
  if (!token) return { status: "reauthorize" };
  let visible: number[];
  try {
    visible = (await listUserInstallations(token, deps)).map((i) => i.id);
  } catch (err) {
    if (err instanceof GitHubUserTokenError) {
      await clearUserGitHubToken(deps.db, ctx.userId);
      return { status: "reauthorize" };
    }
    log.warn("could not verify installation access", { orgId: ctx.orgId, installationId, error: errorMessage(err) });
    return { status: "github_unavailable" };
  }
  const logger = log.child({ orgId: ctx.orgId, userId: ctx.userId, installationId });
  if (!visible.includes(installationId)) {
    logger.warn("refused to connect an installation the user cannot access");
    return { status: "not_accessible" };
  }
  try {
    const result = await claimPendingInstallation(deps.db, deps.host, { orgId: ctx.orgId, orgName: ctx.orgName, installationId });
    await deps.enqueue(result.repos);
    logger.info("pending GitHub installation connected", { repos: result.repos.length });
    return { status: "connected", repos: result.repos.length, missingPermissions: result.missingPermissions };
  } catch (err) {
    if (err instanceof PendingInstallationNotFoundError) return { status: "not_found" };
    if (err instanceof InstallationOwnershipError) return { status: "owned_elsewhere" };
    throw err;
  }
}

// ---- repository selection ---------------------------------------------------------------------------------------

/**
 * Turns reviews on for exactly `enabledIds` among the org's repositories and off for the rest (R6.2). Archived
 * repositories and ids of other orgs are ignored. Returns the repositories that were just turned on.
 */
export async function setEnabledRepos(db: Db, orgId: string, enabledIds: number[]) {
  const ids = [...new Set(enabledIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  return db.transaction(async (tx) => {
    const githubInstallations = tx.select({ id: installations.id }).from(installations).where(scoped(installations, orgId, eq(installations.provider, "github")));
    const turnedOn = ids.length
      ? await tx
          .update(repos)
          .set({ enabled: true })
          .where(scoped(repos, orgId, inArray(repos.id, ids), inArray(repos.installationId, githubInstallations), eq(repos.archived, false), eq(repos.enabled, false)))
          .returning()
      : [];
    const turnedOff = await tx
      .update(repos)
      .set({ enabled: false })
      // Only GitHub App repositories are chosen here; GitLab / Bitbucket repositories are enabled (with their webhooks) on
      // Settings → Git providers and are left as they are.
      .where(scoped(repos, orgId, eq(repos.enabled, true), inArray(repos.installationId, githubInstallations), ids.length ? notInArray(repos.id, ids) : undefined))
      .returning({ id: repos.id });
    const [on] = await tx.select({ n: count() }).from(repos).where(scoped(repos, orgId, eq(repos.enabled, true)));
    return { turnedOn, turnedOff: turnedOff.length, enabled: Number(on?.n ?? 0) };
  });
}

// ---- indexing progress ------------------------------------------------------------------------------------------

export interface RepoIndexProgress {
  repoId: number;
  fullName: string;
  indexStatus: string;
  indexError: string | null;
  fileCount: number;
  /** The running or queued run, or the last finished one. */
  job: { id: number; status: string; phase: string; filesDone: number; filesTotal: number; error: string | null } | null;
}

function jobView(s: IndexStatus): RepoIndexProgress["job"] {
  const j = s.current ?? s.last;
  if (!j) return null;
  return { id: j.id, status: j.status, phase: j.progress.phase, filesDone: j.progress.filesDone, filesTotal: j.progress.filesTotal, error: j.error ?? null };
}

/** Live index progress of the org's enabled repositories (R6.2), for `GET /api/orgs/current/index-status`. */
export async function indexProgressForOrg(db: Db, orgId: string, limit = 50): Promise<RepoIndexProgress[]> {
  const rows = await db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(repos)
    .where(scoped(repos, orgId, eq(repos.enabled, true), eq(repos.archived, false)))
    .orderBy(repos.fullName)
    .limit(limit);
  const out: RepoIndexProgress[] = [];
  for (const r of rows) {
    const s = await getIndexStatus(db, orgId, r.id);
    if (!s) continue;
    out.push({ repoId: r.id, fullName: r.fullName, indexStatus: s.indexStatus, indexError: s.indexError, fileCount: s.fileCount, job: jobView(s) });
  }
  return out;
}

/**
 * `GET /api/orgs/current/index-status` (R6.2): the signed-in user's active org's enabled repositories with their
 * index progress. 401 when signed out, 403 without an active org; the org always comes from the session.
 */
export function createIndexStatusHandler(factory: () => { db: Db; clock: SessionClock }) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const auth = await authorizeRequest(deps, req);
    if (!auth.ok) return auth.response;
    const repos = await indexProgressForOrg(deps.db, auth.ctx.orgId);
    const settled = repos.every((r) => r.indexStatus === "ready" || r.indexStatus === "failed");
    return Response.json({ repos, settled }, { headers: { "cache-control": "no-store" } });
  };
}

// ---- ready: review an existing pull request ---------------------------------------------------------------------

export const manualReviewSchema = z.object({
  repoId: z.coerce.number().int().positive({ message: "Pick a repository." }),
  prNumber: z.coerce.number().int({ message: "Enter a pull request number." }).positive({ message: "Enter a pull request number." }).max(1_000_000_000),
});

export type ManualReviewOutcome = { status: "queued"; reviewId: number; runId: number } | { status: "invalid" | "not_found" | "disabled" | "forbidden" | "limited"; message: string };

/**
 * "Review an existing pull request" (R6.2): validates the form and requests a `manual` review of a pull request in
 * one of the org's enabled repositories.
 */
export async function requestManualReview(
  deps: { db: Db; queue: JobQueue },
  ctx: { orgId: string; userId: string; role: Role },
  input: { repoId: unknown; prNumber: unknown },
): Promise<ManualReviewOutcome> {
  if (!can(ctx.role, "reviews.trigger")) return { status: "forbidden", message: "You can't request reviews in this organization." };
  const parsed = manualReviewSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", message: parsed.error.issues[0]?.message ?? "Check the form." };
  const [repo] = await deps.db
    .select({ id: repos.id, enabled: repos.enabled, archived: repos.archived })
    .from(repos)
    .where(scoped(repos, ctx.orgId, eq(repos.id, parsed.data.repoId)));
  if (!repo) return { status: "not_found", message: "That repository isn't connected to this organization." };
  if (!repo.enabled || repo.archived) return { status: "disabled", message: "Turn reviews on for that repository first." };
  try {
    const run = await requestReview(deps, {
      orgId: ctx.orgId,
      repoId: repo.id,
      prNumber: parsed.data.prNumber,
      trigger: "manual",
      requestedBy: ctx.userId,
      meta: { requestedBy: ctx.userId },
    });
    return { status: "queued", reviewId: run.reviewId, runId: run.runId };
  } catch (err) {
    if (err instanceof ReviewRequestError) return { status: "not_found", message: "That repository isn't connected to this organization." };
    if (err instanceof UsageLimitError) return { status: "limited", message: err.message };
    throw err;
  }
}

/** Repositories offered by the "Review an existing pull request" form. */
export async function reviewableRepos(db: Db, orgId: string) {
  return db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(repos)
    .where(and(scoped(repos, orgId, eq(repos.enabled, true), eq(repos.archived, false))))
    .orderBy(repos.fullName);
}
