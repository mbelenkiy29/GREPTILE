/**
 * Shared webhook processing for GitLab and Bitbucket Cloud (R3.6). Both hosts deliver to a per-repository webhook that
 * OpenReview created with its own random secret, so a verified delivery already names its repository (and therefore
 * its org): the receivers in `./gitlab.ts` and `./bitbucket.ts` verify the token / signature against that hook's
 * secret, then hand the delivery here. Deliveries are recorded and deduped in `webhook_deliveries` exactly like
 * GitHub's (R1.2, R6.21): a failed one keeps its redacted payload and can be replayed from the dashboard.
 */
import { and, eq } from "drizzle-orm";
import { postLimitNotice } from "@/lib/billing/notices";
import { loadEffectiveConfig } from "@/lib/config/repo-config";
import { resolveEffectiveSettings, type EffectiveSettings } from "@/lib/config/settings";
import { claimDelivery, failDelivery, finishDelivery, getDelivery } from "@/lib/data/deliveries";
import type { Db } from "@/lib/db";
import { humanReviewComments, installations, orgs, repos, reviewComments, reviews, scmCredentials, scmWebhooks } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import { clientFor } from "@/lib/git/hosts";
import type { GitClient, GitHost } from "@/lib/git/types";
import type { JobMeta, JobQueue, MentionKind, ReviewTrigger } from "@/lib/jobs/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { requestReview } from "@/lib/pipeline/request";

export interface ScmWebhookDeps {
  db: Db;
  queue: JobQueue;
  /** The git hosts (a `GitHosts` registry, or the provider's own host in tests). */
  host: GitHost;
  botMention: string;
  now?: () => Date;
  log?: Logger;
}

export type RepoRow = typeof repos.$inferSelect;
export type InstallationRow = typeof installations.$inferSelect;
export type CredentialRow = typeof scmCredentials.$inferSelect;

/** The repository a verified delivery is for, with its installation and connection. */
export interface ScmTarget {
  repo: RepoRow;
  installation: InstallationRow;
  credential: CredentialRow;
}

export type RouteOutcome = { status: "ignored"; reason: string } | { status: "accepted"; jobs: string[] };
export type DeliveryResult = RouteOutcome | { status: "duplicate"; inFlight?: true } | { status: "failed"; error: string };

export interface ScmContext {
  deliveryId: string;
  log: Logger;
  meta: JobMeta;
  prNumber?: number;
}

export const accepted = (jobs: string[] = []): RouteOutcome => ({ status: "accepted", jobs });
export const ignored = (reason: string): RouteOutcome => ({ status: "ignored", reason });

export type ScmRouter = (deps: ScmWebhookDeps, event: string, payload: unknown, ctx: ScmContext, target: ScmTarget) => Promise<RouteOutcome>;

/** Delivery ids the hosts send (UUIDs, idempotency keys) or a body hash; anything else is refused. */
export const SCM_DELIVERY_ID = /^[\w.-]{1,128}$/;

/** True when a comment is OpenReview's own (every comment it writes carries an `openreview:` marker). */
export function isOwnComment(body: string): boolean {
  return /<!-- openreview:[\w:=.-]+ -->|^\[\/\/\]: # \(openreview:[\w:=.-]+\)$/m.test(body);
}

/** Finds the verified hook's repository, installation, and connection. */
export async function hookTarget(db: Db, hook: { orgId: string; repoId: number; credentialId: number }): Promise<ScmTarget | undefined> {
  const [row] = await db
    .select({ repo: repos, installation: installations, credential: scmCredentials })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .innerJoin(scmCredentials, eq(scmCredentials.id, hook.credentialId))
    .where(and(scoped(repos, hook.orgId, eq(repos.id, hook.repoId)), eq(installations.scmCredentialId, hook.credentialId)));
  return row;
}

/** The webhook record for a repository, for verifying a delivery (never exposed). */
export async function repoHook(db: Db, provider: string, where: { secretHash?: string; externalHookId?: string }) {
  const cond = where.secretHash !== undefined ? eq(scmWebhooks.secretHash, where.secretHash) : eq(scmWebhooks.externalHookId, where.externalHookId ?? "");
  const [row] = await db
    .select()
    .from(scmWebhooks)
    .where(and(eq(scmWebhooks.provider, provider), cond));
  return row;
}

function client(deps: ScmWebhookDeps, target: ScmTarget): GitClient {
  return clientFor(deps.host, target.installation);
}

/**
 * Effective settings for gating a webhook (R6.14): org ← repo ← `openreview.json` at the PR's base commit. When the
 * file cannot be read, the dashboard settings gate and the job re-checks with the file.
 */
async function webhookSettings(deps: ScmWebhookDeps, ctx: ScmContext, target: ScmTarget, baseSha: string): Promise<{ settings: EffectiveSettings; fileRead: boolean }> {
  const [org] = await deps.db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, target.repo.orgId));
  try {
    return { settings: (await loadEffectiveConfig(client(deps, target), target.repo.fullName, baseSha, target.repo.settings, org?.settings)).settings, fileRead: true };
  } catch (err) {
    ctx.log.info("openreview.json unavailable at the webhook; gating with dashboard settings", { error: errorMessage(err) });
  }
  return { settings: resolveEffectiveSettings(org?.settings, target.repo.settings, undefined).settings, fileRead: false };
}

/**
 * Requests a review for a pull request event: the PR is read from the host (full shas, draft state), the settings
 * gates and usage limits apply before a run is recorded, and a limited request posts the one-time notice.
 */
export async function reviewPullRequest(
  deps: ScmWebhookDeps,
  ctx: ScmContext,
  target: ScmTarget,
  input: { prNumber: number; trigger: Exclude<ReviewTrigger, "recovery" | "manual" | "mention" | "api" | "cli">; skipIfReviewed?: boolean },
): Promise<RouteOutcome> {
  const { repo, installation } = target;
  if (installation.suspended) return ignored("installation suspended");
  if (repo.archived) return ignored("repository archived");
  if (!repo.enabled) return ignored("reviews disabled for repository");
  const c = client(deps, target);
  const pr = await c.getPullRequest(repo.fullName, input.prNumber);
  if (pr.state !== "open") return ignored("pull request is not open");
  if (input.skipIfReviewed) {
    // Bitbucket sends `pullrequest:updated` for title and description edits too: only a new head is reviewed.
    const [existing] = await deps.db
      .select({ headSha: reviews.headSha, status: reviews.status })
      .from(reviews)
      .where(scoped(reviews, repo.orgId, eq(reviews.repoId, repo.id), eq(reviews.prNumber, pr.number)));
    if (existing?.headSha === pr.headSha && existing.status !== "failed") return ignored("no new commits");
  }
  const { settings, fileRead } = await webhookSettings(deps, ctx, target, pr.baseSha);
  const requested = await requestReview(
    { db: deps.db, queue: deps.queue, log: ctx.log },
    {
      orgId: repo.orgId,
      repoId: repo.id,
      prNumber: pr.number,
      headSha: pr.headSha,
      trigger: input.trigger,
      ...(pr.author ? { author: pr.author } : {}),
      meta: ctx.meta,
      gate: { draft: pr.draft && fileRead, baseRef: pr.baseRef, headRef: pr.headRef, settings },
    },
  );
  if ("gated" in requested) return ignored(requested.reason);
  if ("limited" in requested) {
    await postLimitNotice(
      deps.db,
      c,
      { orgId: repo.orgId, repoId: repo.id, repoFullName: repo.fullName, prNumber: pr.number, code: requested.code, reason: requested.reason, period: requested.period },
      ctx.log,
    );
    return ignored(`${requested.code}: review run ${requested.runId} skipped`);
  }
  return accepted([requested.jobId]);
}

/** A closed / merged / declined pull request: collect feedback (R2.4) and mine teammates' comments for rules (R2.5). */
export async function closedPullRequest(deps: ScmWebhookDeps, ctx: ScmContext, target: ScmTarget, prNumber: number): Promise<RouteOutcome> {
  const { repo } = target;
  const feedbackId = `feedback-${repo.id}-${prNumber}-closed`;
  await deps.queue.add("sync-feedback", { orgId: repo.orgId, repoId: repo.id, prNumber, meta: ctx.meta }, { jobId: feedbackId });
  const mineId = `mine-${repo.id}-${prNumber}`;
  await deps.queue.add("mine-rules", { orgId: repo.orgId, repoId: repo.id, meta: ctx.meta }, { jobId: mineId });
  return accepted([feedbackId, mineId]);
}

/** Whether `commentId` is one of OpenReview's inline comments on this org's repository. */
export async function isOurComment(db: Db, orgId: string, commentId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: reviewComments.id })
    .from(reviewComments)
    .where(and(eq(reviewComments.orgId, orgId), eq(reviewComments.externalId, commentId)));
  return Boolean(row);
}

export interface IncomingComment {
  prNumber: number;
  id: number;
  body: string;
  author: string;
  /** Inline (diff) thread: the thread's root comment id; undefined for a plain pull request comment. */
  threadRoot?: number;
  path?: string;
  line?: number | null;
  /** Inline comment (as opposed to a reply in a non-diff thread); only those are kept for rule mining. */
  inline: boolean;
  /** GitHub-style association (OWNER/MEMBER/COLLABORATOR/…) when the host's membership could be read. */
  authorAssociation?: string;
}

/**
 * A comment on a pull request: replies to OpenReview's inline comments sync feedback, a mention (or `/openreview`
 * command) is answered in its thread, and a teammate's inline comment is kept for rule mining.
 */
export async function onPullRequestComment(deps: ScmWebhookDeps, ctx: ScmContext, target: ScmTarget, c: IncomingComment, addressed: boolean): Promise<RouteOutcome> {
  const { repo } = target;
  const jobs: string[] = [];
  let repliesToUs = false;
  if (c.threadRoot !== undefined && c.threadRoot !== c.id && (await isOurComment(deps.db, repo.orgId, c.threadRoot))) {
    repliesToUs = true;
    const jobId = `feedback-${repo.id}-${c.prNumber}-${c.id}`;
    await deps.queue.add("sync-feedback", { orgId: repo.orgId, repoId: repo.id, prNumber: c.prNumber, meta: ctx.meta }, { jobId });
    jobs.push(jobId);
  }
  if (addressed) {
    const kind: MentionKind = c.threadRoot !== undefined ? "review_comment" : "issue_comment";
    const jobId = `mention-${repo.id}-${kind === "review_comment" ? "rc" : "c"}-${c.id}`;
    await deps.queue.add(
      "answer-mention",
      {
        orgId: repo.orgId,
        repoId: repo.id,
        prNumber: c.prNumber,
        commentId: c.id,
        body: c.body,
        author: c.author,
        kind,
        ...(c.threadRoot !== undefined ? { inReplyTo: c.threadRoot } : {}),
        ...(c.path ? { path: c.path } : {}),
        ...(c.threadRoot !== undefined ? { line: c.line ?? null } : {}),
        ...(c.authorAssociation ? { authorAssociation: c.authorAssociation } : {}),
        meta: ctx.meta,
      },
      { jobId },
    );
    jobs.push(jobId);
  }
  if (!repliesToUs && !addressed && c.inline) {
    await deps.db
      .insert(humanReviewComments)
      .values({ orgId: repo.orgId, repoId: repo.id, prNumber: c.prNumber, externalId: c.id, author: c.author, path: c.path ?? "", body: c.body.slice(0, 8000) })
      .onConflictDoNothing();
  }
  if (!jobs.length && !c.inline) return ignored("no mention");
  return accepted(jobs);
}

/** A push: a new default-branch head queues an incremental (or first full) index. */
export async function onDefaultBranchPush(deps: ScmWebhookDeps, ctx: ScmContext, target: ScmTarget, push: { branch: string; after: string | null }): Promise<RouteOutcome> {
  const { repo } = target;
  if (push.branch !== repo.defaultBranch) return ignored("not the default branch");
  if (!push.after || /^0+$/.test(push.after)) return ignored("branch deleted");
  if (!repo.enabled || repo.archived) return ignored("reviews disabled for repository");
  const jobId = `index-${repo.id}-${push.after}`;
  await deps.queue.add(
    "index-repo",
    { orgId: repo.orgId, repoId: repo.id, mode: repo.indexedSha ? "incremental" : "full", afterSha: push.after, trigger: "push", meta: ctx.meta },
    { jobId },
  );
  return accepted([jobId]);
}

/**
 * Processes one verified delivery exactly once: claims it (dedupe by delivery id), routes it, and records the
 * outcome; a routing error marks it failed with its redacted payload so the host's retry or a replay can redo it.
 */
export async function processScmDelivery(
  deps: ScmWebhookDeps,
  router: ScmRouter,
  input: { provider: string; deliveryId: string; event: string; action?: string; payload: unknown; payloadSha256?: string; target: ScmTarget; requestedBy?: string },
): Promise<DeliveryResult> {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const { target } = input;
  const ctx: ScmContext = {
    deliveryId: input.deliveryId,
    meta: { deliveryId: input.deliveryId, ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}) },
    log: (deps.log ?? rootLog).child({
      deliveryId: input.deliveryId,
      provider: input.provider,
      event: input.event,
      ...(input.action ? { action: input.action } : {}),
      orgId: target.repo.orgId,
      repoId: target.repo.id,
      repo: target.repo.fullName,
    }),
  };
  const context = { orgId: target.repo.orgId, installationId: target.installation.externalId, repoId: target.repo.id, repoFullName: target.repo.fullName };
  const claim = await claimDelivery(db, {
    deliveryId: input.deliveryId,
    provider: input.provider,
    event: input.event,
    action: input.action ?? null,
    installationId: context.installationId,
    orgId: context.orgId,
    ...(input.payloadSha256 ? { payloadSha256: input.payloadSha256 } : {}),
    now: now(),
  });
  if (claim.kind === "duplicate") {
    ctx.log.info("duplicate delivery skipped", { previous: claim.status });
    return { status: "duplicate" };
  }
  if (claim.kind === "in_flight") return { status: "duplicate", inFlight: true };
  const started = performance.now();
  try {
    const outcome = await router(deps, input.event, input.payload, ctx, target);
    const durationMs = Math.round(performance.now() - started);
    await finishDelivery(db, input.deliveryId, {
      status: outcome.status,
      reason: outcome.status === "ignored" ? outcome.reason : undefined,
      jobs: outcome.status === "accepted" ? outcome.jobs : [],
      ...context,
      durationMs,
      now: now(),
    });
    ctx.log.info("webhook processed", { status: outcome.status, ...(outcome.status === "ignored" ? { reason: outcome.reason } : { jobs: outcome.jobs }), attempts: claim.attempts, durationMs });
    return outcome;
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const error = errorMessage(err);
    ctx.log.error("webhook processing failed", { error, attempts: claim.attempts, durationMs });
    try {
      await failDelivery(db, input.deliveryId, { error, payload: input.payload, ...context, durationMs, now: now() });
    } catch (recordErr) {
      ctx.log.error("could not record webhook failure", { error: errorMessage(recordErr) });
    }
    return { status: "failed", error };
  }
}

/** The receiver's HTTP answer for a processing result (accepted → 202, ignored / duplicate → 200, failed → 500). */
export function deliveryResponse(result: DeliveryResult, deliveryId: string): Response {
  switch (result.status) {
    case "failed":
      return Response.json({ status: "failed", deliveryId }, { status: 500 });
    case "accepted":
      return Response.json(result, { status: 202 });
    case "duplicate":
      return Response.json(result, { status: result.inFlight ? 202 : 200 });
    default:
      return Response.json(result, { status: 200 });
  }
}

export type ScmReplayResult = DeliveryResult | { status: "not_found" } | { status: "not_replayable"; reason: string };

/**
 * Re-routes a failed GitLab / Bitbucket delivery from its stored payload (R6.21). The repository comes from the
 * delivery record, which belongs to the org, so a replay can only act on that org's repository.
 */
export async function replayScmDelivery(deps: ScmWebhookDeps, router: ScmRouter, provider: string, orgId: string, deliveryId: string, opts: { requestedBy?: string } = {}): Promise<ScmReplayResult> {
  const row = await getDelivery(deps.db, orgId, deliveryId);
  if (!row || row.provider !== provider) return { status: "not_found" };
  if (row.status !== "failed") return { status: "not_replayable", reason: `delivery is ${row.status}` };
  if (row.payload === null || row.payload === undefined) return { status: "not_replayable", reason: "payload was not kept" };
  if (row.repoId === null) return { status: "not_replayable", reason: "repository unknown" };
  const [found] = await deps.db
    .select({ repo: repos, installation: installations, credential: scmCredentials })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .innerJoin(scmCredentials, eq(scmCredentials.id, installations.scmCredentialId))
    .where(scoped(repos, orgId, eq(repos.id, row.repoId), eq(installations.provider, provider)));
  if (!found) return { status: "not_replayable", reason: "repository is no longer connected" };
  return processScmDelivery(deps, router, {
    provider,
    deliveryId,
    event: row.event,
    ...(row.action ? { action: row.action } : {}),
    payload: row.payload,
    ...(row.payloadSha256 ? { payloadSha256: row.payloadSha256 } : {}),
    target: found,
    ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
  });
}
