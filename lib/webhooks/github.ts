import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/lib/db";
import { humanReviewComments, installations, orgs, repos, reviewComments, type RepoSettings } from "@/lib/db/schema";
import { loadEffectiveConfig } from "@/lib/config/repo-config";
import { resolveEffectiveSettings, type EffectiveSettings } from "@/lib/config/settings";
import { claimDelivery, failDelivery, finishDelivery, getDelivery } from "@/lib/data/deliveries";
import {
  deleteInstallation,
  deleteInstallationRepo,
  deletePendingInstallation,
  findInstallationByExternalId,
  refreshInstallationPermissions,
  setInstallationSuspended,
  storePendingInstallation,
  syncInstallationRepos,
  updateInstallationDetails,
  updateInstallationRepo,
  updatePendingPermissions,
} from "@/lib/data/installations";
import type { GitHost } from "@/lib/git/types";
import { enqueueIndexForNewRepos } from "@/lib/jobs/enqueue";
import type { JobMeta, JobQueue, ReviewTrigger } from "@/lib/jobs/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { requestReview } from "@/lib/pipeline/request";
import {
  envelopeSchema,
  installationPayload,
  installationRepositoriesPayload,
  issueCommentPayload,
  pullRequestPayload,
  pushPayload,
  repositoryPayload,
  reviewCommentPayload,
  reviewPayload,
  type Actor,
} from "./payloads";
import { verifyGitHubSignature } from "./signature";
import { addressesBot, mentionsBot } from "@/lib/learning/commands";

export interface WebhookDeps {
  db: Db;
  queue: JobQueue;
  host: GitHost;
  secret: string;
  botMention: string;
  /** The GitHub App's slug; events from `<slug>[bot]` (our own comments) are ignored. */
  appSlug?: string;
  now?: () => Date;
  log?: Logger;
}

/** What routing and delivery processing need; the signing secret is only used by the HTTP receiver. */
export type RouteDeps = Omit<WebhookDeps, "secret">;

/** What routing one event decided: jobs were enqueued (possibly none), or the event was ignored and why. */
export type RouteOutcome = { status: "ignored"; reason: string } | { status: "accepted"; jobs: string[] };

/** The receiver's answer: a routing outcome, or a duplicate (already processed, or still in flight). */
export type WebhookOutcome = RouteOutcome | { status: "duplicate"; inFlight?: true };

/** Result of processing one delivery: the routing outcome, or a failure that was recorded for retry/replay. */
export type DeliveryResult = WebhookOutcome | { status: "failed"; error: string };

/** Correlation ids learned while routing one delivery; recorded on the delivery row and carried by its logs. */
export interface DeliveryContext {
  deliveryId: string;
  action?: string;
  log: Logger;
  meta: JobMeta;
  installationId?: number;
  orgId?: string;
  repoId?: number;
  repoFullName?: string;
  prNumber?: number;
}

const PR_ACTIONS = new Set<ReviewTrigger>(["opened", "synchronize", "reopened", "ready_for_review"]);

const accepted = (jobs: string[] = []): RouteOutcome => ({ status: "accepted", jobs });
const ignored = (reason: string): RouteOutcome => ({ status: "ignored", reason });

export { mentionsBot };

/** True for GitHub bot accounts and for this app's own `<slug>[bot]` user. */
export function isBotActor(actor: Actor | null | undefined, appSlug?: string): boolean {
  if (!actor) return false;
  if (actor.type === "Bot") return true;
  return Boolean(appSlug && actor.login && actor.login.toLowerCase() === `${appSlug.toLowerCase()}[bot]`);
}

function setOrg(ctx: DeliveryContext, orgId: string) {
  if (ctx.orgId === orgId) return;
  ctx.orgId = orgId;
  ctx.log = ctx.log.child({ orgId });
}

function setRepo(ctx: DeliveryContext, repo: { id: number; orgId: string; fullName: string }) {
  setOrg(ctx, repo.orgId);
  ctx.repoId = repo.id;
  ctx.repoFullName = repo.fullName;
  ctx.log = ctx.log.child({ repoId: repo.id, repo: repo.fullName });
}

function setPr(ctx: DeliveryContext, prNumber: number) {
  ctx.prNumber = prNumber;
  ctx.log = ctx.log.child({ prNumber });
}

function parse<S extends z.ZodType>(schema: S, payload: unknown, ctx: DeliveryContext): z.infer<S> | undefined {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  ctx.log.warn("malformed webhook payload", { issue: issue?.message, at: issue?.path.map(String).join(".") });
  return undefined;
}

/** The connected repository an event is about, looked up by the host's installation and repository ids. */
async function connectedRepo(db: Db, host: GitHost, ctx: DeliveryContext, installationId?: number, repoExternalId?: number) {
  if (installationId === undefined || repoExternalId === undefined) return undefined;
  const [row] = await db
    .select({ repo: repos, installation: installations })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(
      and(
        eq(installations.provider, host.provider),
        eq(installations.externalId, installationId),
        eq(repos.externalId, repoExternalId),
      ),
    );
  if (row) setRepo(ctx, row.repo);
  return row;
}

async function linkedInstallation(db: Db, host: GitHost, ctx: DeliveryContext, installationId: number) {
  const row = await findInstallationByExternalId(db, host.provider, installationId);
  if (row) setOrg(ctx, row.orgId);
  return row;
}

/**
 * Effective review settings for gating a webhook (R6.14): org ← repo ← `openreview.json` at the PR's base commit, so
 * the file wins here exactly as it does in the job (R2.2). A payload without the base commit gets it from the PR.
 * `fileRead` is false when the file could not be read (a git host error): the org and repo settings then gate
 * auto-review and branches, and the caller leaves the draft decision to the job, which re-checks every gate with the
 * file.
 */
async function webhookSettings(
  deps: RouteDeps,
  ctx: DeliveryContext,
  repo: { orgId: string; fullName: string; settings: RepoSettings },
  installation: { externalId: number },
  pr: { number: number; baseSha: string | undefined },
): Promise<{ settings: EffectiveSettings; fileRead: boolean }> {
  const [org] = await deps.db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, repo.orgId));
  try {
    const client = deps.host.client(installation.externalId);
    const baseSha = pr.baseSha ?? (await client.getPullRequest(repo.fullName, pr.number)).baseSha;
    return { settings: (await loadEffectiveConfig(client, repo.fullName, baseSha, repo.settings, org?.settings)).settings, fileRead: true };
  } catch (err) {
    ctx.log.info("openreview.json unavailable at the webhook; gating with dashboard settings", { error: errorMessage(err) });
  }
  return { settings: resolveEffectiveSettings(org?.settings, repo.settings, undefined).settings, fileRead: false };
}

async function onPullRequest(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const { db, queue, host } = deps;
  const p = parse(pullRequestPayload, payload, ctx);
  if (!p) return ignored("malformed pull_request payload");
  const pr = p.pull_request;
  setPr(ctx, pr.number);

  if (p.action === "closed") {
    // Reactions have no webhook; collect feedback on our comments once the PR is done (R2.4).
    const found = await connectedRepo(db, host, ctx, p.installation?.id, p.repository?.id);
    if (!found) return ignored("repository not connected");
    const { repo } = found;
    const feedbackId = `feedback-${repo.id}-${pr.number}-closed`;
    await queue.add("sync-feedback", { orgId: repo.orgId, repoId: repo.id, prNumber: pr.number, meta: ctx.meta }, { jobId: feedbackId });
    // Teammates' comments on the finished PR may hold conventions worth turning into rules (R2.5).
    const mineId = `mine-${repo.id}-${pr.number}`;
    await queue.add("mine-rules", { orgId: repo.orgId, repoId: repo.id, meta: ctx.meta }, { jobId: mineId });
    return accepted([feedbackId, mineId]);
  }

  if (!PR_ACTIONS.has(p.action as ReviewTrigger)) return ignored(`pull_request.${p.action}`);
  if (isBotActor(p.sender, deps.appSlug)) return ignored("event sent by a bot");
  if (!pr.head) return ignored("malformed pull_request payload");
  const found = await connectedRepo(db, host, ctx, p.installation?.id, p.repository?.id);
  if (!found) return ignored("repository not connected");
  const { repo, installation } = found;
  if (installation.suspended) return ignored("installation suspended");
  if (repo.archived) return ignored("repository archived");
  if (!repo.enabled) return ignored("reviews disabled for repository");
  // The settings gates (auto-review, re-review, drafts, branches) run before a run is recorded, so a gated event
  // never supersedes a review in progress (R6.14).
  const { settings, fileRead } = await webhookSettings(deps, ctx, repo, installation, { number: pr.number, baseSha: pr.base?.sha });
  const requested = await requestReview(
    { db, queue, log: ctx.log },
    {
      orgId: repo.orgId,
      repoId: repo.id,
      prNumber: pr.number,
      headSha: pr.head.sha,
      trigger: p.action as Exclude<ReviewTrigger, "recovery">,
      meta: ctx.meta,
      // `reviewDrafts: true` in openreview.json must be able to take effect: when the file could not be read, the
      // draft decision is left to the job (it reads the file and skips the run if drafts are not reviewed).
      gate: { draft: Boolean(pr.draft) && fileRead, baseRef: pr.base?.ref, headRef: pr.head.ref, settings },
    },
  );
  if ("gated" in requested) return ignored(requested.reason);
  return accepted([requested.jobId]);
}

async function onReviewComment(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const { db, queue, host } = deps;
  const p = parse(reviewCommentPayload, payload, ctx);
  if (!p) return ignored("malformed pull_request_review_comment payload");
  if (p.action !== "created") return ignored(`pull_request_review_comment.${p.action}`);
  const comment = p.comment;
  if (isBotActor(comment.user, deps.appSlug) || isBotActor(p.sender, deps.appSlug)) return ignored("comment by a bot");
  const prNumber = p.pull_request.number;
  setPr(ctx, prNumber);
  const found = await connectedRepo(db, host, ctx, p.installation?.id, p.repository?.id);
  if (!found) return ignored("repository not connected");
  const { repo } = found;
  const body = comment.body ?? "";
  const jobs: string[] = [];

  let repliesToUs = false;
  if (comment.in_reply_to_id) {
    const [ours] = await db
      .select({ id: reviewComments.id })
      .from(reviewComments)
      .where(and(eq(reviewComments.orgId, repo.orgId), eq(reviewComments.externalId, comment.in_reply_to_id)));
    if (ours) {
      repliesToUs = true;
      const jobId = `feedback-${repo.id}-${prNumber}-${comment.id}`;
      await queue.add("sync-feedback", { orgId: repo.orgId, repoId: repo.id, prNumber, meta: ctx.meta }, { jobId });
      jobs.push(jobId);
    }
  }

  // A mention, or a `/openreview <command>` (R6.17).
  const mentioned = addressesBot(body, deps.botMention);
  if (mentioned) {
    // Answer in the same thread: replies attach to the thread's top-level comment (R1.7). Review-comment ids are a
    // separate sequence from issue-comment ids, so they get their own job id namespace.
    const jobId = `mention-${repo.id}-rc-${comment.id}`;
    await queue.add(
      "answer-mention",
      {
        orgId: repo.orgId,
        repoId: repo.id,
        prNumber,
        commentId: comment.id,
        body,
        author: comment.user?.login ?? "",
        kind: "review_comment",
        inReplyTo: comment.in_reply_to_id ?? comment.id,
        ...(comment.path ? { path: comment.path } : {}),
        line: comment.line ?? comment.original_line ?? null,
        ...(comment.author_association ? { authorAssociation: comment.author_association } : {}),
        meta: ctx.meta,
      },
      { jobId },
    );
    jobs.push(jobId);
  }

  if (!repliesToUs && !mentioned) {
    // A teammate's own review comment: keep it for rule mining (R2.5).
    await db
      .insert(humanReviewComments)
      .values({
        orgId: repo.orgId,
        repoId: repo.id,
        prNumber,
        externalId: comment.id,
        author: comment.user?.login ?? "",
        path: comment.path ?? "",
        body: body.slice(0, 8000),
      })
      .onConflictDoNothing();
  }
  return accepted(jobs);
}

async function onReview(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const p = parse(reviewPayload, payload, ctx);
  if (!p) return ignored("malformed pull_request_review payload");
  if (p.action !== "submitted") return ignored(`pull_request_review.${p.action}`);
  const review = p.review;
  if (isBotActor(review.user, deps.appSlug) || isBotActor(p.sender, deps.appSlug)) return ignored("review by a bot");
  const body = review.body ?? "";
  if (!addressesBot(body, deps.botMention)) return ignored("no mention");
  const prNumber = p.pull_request.number;
  setPr(ctx, prNumber);
  const found = await connectedRepo(deps.db, deps.host, ctx, p.installation?.id, p.repository?.id);
  if (!found) return ignored("repository not connected");
  const { repo } = found;
  const jobId = `mention-${repo.id}-review-${review.id}`;
  await deps.queue.add(
    "answer-mention",
    {
      orgId: repo.orgId,
      repoId: repo.id,
      prNumber,
      commentId: review.id,
      body,
      author: review.user?.login ?? "",
      kind: "review",
      ...(review.author_association ? { authorAssociation: review.author_association } : {}),
      meta: ctx.meta,
    },
    { jobId },
  );
  return accepted([jobId]);
}

async function onIssueComment(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const p = parse(issueCommentPayload, payload, ctx);
  if (!p) return ignored("malformed issue_comment payload");
  if (p.action !== "created") return ignored(`issue_comment.${p.action}`);
  const comment = p.comment;
  if (!p.issue.pull_request) return ignored("comment is not on a pull request");
  if (isBotActor(comment.user, deps.appSlug) || isBotActor(p.sender, deps.appSlug)) return ignored("comment by a bot");
  const body = comment.body ?? "";
  if (!addressesBot(body, deps.botMention)) return ignored("no mention");
  setPr(ctx, p.issue.number);
  const found = await connectedRepo(deps.db, deps.host, ctx, p.installation?.id, p.repository?.id);
  if (!found) return ignored("repository not connected");
  const { repo } = found;
  const jobId = `mention-${repo.id}-${comment.id}`;
  await deps.queue.add(
    "answer-mention",
    {
      orgId: repo.orgId,
      repoId: repo.id,
      prNumber: p.issue.number,
      commentId: comment.id,
      body,
      author: comment.user?.login ?? "",
      kind: "issue_comment",
      ...(comment.author_association ? { authorAssociation: comment.author_association } : {}),
      meta: ctx.meta,
    },
    { jobId },
  );
  return accepted([jobId]);
}

async function onPush(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const { db, host } = deps;
  const p = parse(pushPayload, payload, ctx);
  if (!p) return ignored("malformed push payload");
  const found = await connectedRepo(db, host, ctx, p.installation?.id, p.repository.id);
  if (!found) return ignored("repository not connected");
  let { repo } = found;
  const reported = p.repository.default_branch;
  if (reported && reported !== repo.defaultBranch) {
    // The push payload carries the current default branch; catch up if a `repository.edited` was missed.
    repo = (await updateInstallationRepo(db, found.installation, p.repository.id, { defaultBranch: reported })) ?? repo;
  }
  if (p.ref !== `refs/heads/${repo.defaultBranch}`) return ignored("not the default branch");
  if (p.deleted || /^0+$/.test(p.after)) return ignored("branch deleted");
  const jobId = `index-${repo.id}-${p.after}`;
  await deps.queue.add(
    "index-repo",
    {
      orgId: repo.orgId,
      repoId: repo.id,
      mode: repo.indexedSha ? "incremental" : "full",
      afterSha: p.after,
      trigger: "push",
      meta: ctx.meta,
    },
    { jobId },
  );
  return accepted([jobId]);
}

async function onInstallation(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const { db, host, queue } = deps;
  const p = parse(installationPayload, payload, ctx);
  if (!p) return ignored("malformed installation payload");
  const inst = p.installation;
  const linked = await linkedInstallation(db, host, ctx, inst.id);
  const reported = {
    accountType: inst.account?.type ?? inst.target_type,
    permissions: inst.permissions,
    repositorySelection: inst.repository_selection,
  };

  switch (p.action) {
    case "created": {
      if (!linked) {
        // Nobody has linked it yet: keep it so onboarding can offer it to the installer (R1.1).
        const pending = await storePendingInstallation(db, host.provider, {
          externalId: inst.id,
          accountLogin: inst.account?.login ?? inst.account?.slug ?? "",
          accountType: reported.accountType ?? "User",
          senderLogin: p.sender?.login ?? "",
          senderId: p.sender?.id,
          permissions: inst.permissions,
          repositorySelection: inst.repository_selection,
        });
        ctx.log.info(pending ? "installation pending until claimed" : "installation was linked concurrently");
        return accepted();
      }
      // The install callback linked it first: record what GitHub reports and pick up the selected repos.
      await refreshInstallationPermissions(db, host, linked, reported);
      const synced = await syncInstallationRepos(db, host, linked);
      return accepted(await enqueueIndexForNewRepos(synced, queue, ctx.meta));
    }
    case "deleted": {
      await deletePendingInstallation(db, host.provider, inst.id);
      if (linked) await deleteInstallation(db, linked);
      return accepted();
    }
    case "suspend":
    case "unsuspend": {
      if (!linked) return ignored("installation not linked to an org");
      await setInstallationSuspended(db, linked, p.action === "suspend");
      return accepted();
    }
    case "new_permissions_accepted": {
      if (!linked) {
        if (inst.permissions) await updatePendingPermissions(db, host.provider, inst.id, inst.permissions);
        return accepted();
      }
      await refreshInstallationPermissions(db, host, linked, reported);
      return accepted();
    }
    default:
      return ignored(`installation.${p.action}`);
  }
}

async function onInstallationRepositories(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const { db, host, queue } = deps;
  const p = parse(installationRepositoriesPayload, payload, ctx);
  if (!p) return ignored("malformed installation_repositories payload");
  const linked = await linkedInstallation(db, host, ctx, p.installation.id);
  if (!linked) return ignored("installation not linked to an org");
  const selection = p.repository_selection ?? p.installation.repository_selection;
  if (selection) await updateInstallationDetails(db, linked, { repositorySelection: selection });
  const synced = await syncInstallationRepos(db, host, linked);
  return accepted(await enqueueIndexForNewRepos(synced, queue, ctx.meta));
}

async function onRepository(deps: RouteDeps, payload: unknown, ctx: DeliveryContext): Promise<RouteOutcome> {
  const { db, host, queue } = deps;
  const p = parse(repositoryPayload, payload, ctx);
  if (!p) return ignored("malformed repository payload");
  const linked = await linkedInstallation(db, host, ctx, p.installation.id);
  if (!linked) return ignored("installation not linked to an org");
  const r = p.repository;
  ctx.repoFullName = r.full_name;

  const apply = async (patch: Parameters<typeof updateInstallationRepo>[3]) => {
    const row = await updateInstallationRepo(db, linked, r.id, patch);
    if (row) setRepo(ctx, row);
    return row;
  };
  const resync = async () => {
    const synced = await syncInstallationRepos(db, host, linked);
    const found = synced.find((s) => s.externalId === r.id);
    if (found) setRepo(ctx, found);
    return accepted(await enqueueIndexForNewRepos(synced, queue, ctx.meta));
  };

  switch (p.action) {
    case "renamed":
      return (await apply({ fullName: r.full_name })) ? accepted() : ignored("repository not connected");
    case "transferred":
      // Sent to the new owner's installation; if the repository is new to it, pick it up with a resync.
      return (await apply({ fullName: r.full_name })) ? accepted() : resync();
    case "deleted": {
      const deleted = await deleteInstallationRepo(db, linked, r.id);
      if (!deleted) return ignored("repository not connected");
      ctx.repoId = deleted.id;
      ctx.log = ctx.log.child({ repoId: deleted.id, repo: deleted.fullName });
      return accepted();
    }
    case "archived":
      return (await apply({ archived: true, enabled: false })) ? accepted() : ignored("repository not connected");
    case "unarchived":
      return (await apply({ archived: false })) ? accepted() : ignored("repository not connected");
    case "privatized":
    case "publicized":
      return (await apply({ private: r.private ?? p.action === "privatized" })) ? accepted() : ignored("repository not connected");
    case "edited": {
      if (!p.changes?.default_branch || !r.default_branch) return ignored("repository.edited without a default branch change");
      const row = await apply({ defaultBranch: r.default_branch });
      if (!row) return ignored("repository not connected");
      if (!row.enabled || row.archived) return accepted();
      // The index follows the default branch: re-index the new one.
      const jobId = `index-${row.id}-branch-${ctx.deliveryId}`;
      await queue.add(
        "index-repo",
        { orgId: row.orgId, repoId: row.id, mode: row.indexedSha ? "incremental" : "full", trigger: "default_branch", meta: ctx.meta },
        { jobId },
      );
      return accepted([jobId]);
    }
    case "created":
      return linked.repositorySelection === "all" ? resync() : ignored("repository not selected for the installation");
    default:
      return ignored(`repository.${p.action}`);
  }
}

function newContext(deps: RouteDeps, deliveryId: string, event: string, payload: unknown, requestedBy?: string): DeliveryContext {
  const envelope = envelopeSchema.safeParse(payload);
  const action = envelope.success ? envelope.data.action : undefined;
  const installationId = envelope.success ? envelope.data.installation?.id : undefined;
  return {
    deliveryId,
    action,
    installationId,
    meta: { deliveryId, ...(requestedBy ? { requestedBy } : {}) },
    log: (deps.log ?? rootLog).child({ deliveryId, event, ...(action ? { action } : {}), ...(installationId !== undefined ? { installationId } : {}) }),
  };
}

/** Routes one verified GitHub event to jobs (R1.2). Job ids are deterministic so re-enqueueing is a no-op. */
export async function routeGitHubEvent(
  deps: RouteDeps,
  event: string,
  payload: unknown,
  ctx: DeliveryContext = newContext(deps, "", event, payload),
): Promise<RouteOutcome> {
  switch (event) {
    case "ping":
      return accepted();
    case "pull_request":
      return onPullRequest(deps, payload, ctx);
    case "pull_request_review_comment":
      return onReviewComment(deps, payload, ctx);
    case "pull_request_review":
      return onReview(deps, payload, ctx);
    case "issue_comment":
      return onIssueComment(deps, payload, ctx);
    case "push":
      return onPush(deps, payload, ctx);
    case "installation":
      return onInstallation(deps, payload, ctx);
    case "installation_repositories":
      return onInstallationRepositories(deps, payload, ctx);
    case "repository":
      return onRepository(deps, payload, ctx);
    default:
      return ignored(`unhandled event ${event}`);
  }
}

/**
 * Processes one delivery exactly once (R1.2, R6.21): claims it, routes it, and records the outcome with its
 * correlation ids. A routing error marks the delivery failed with the error and the redacted payload so GitHub's
 * retry (or a replay) can process it again.
 */
export async function processDelivery(
  deps: RouteDeps,
  input: { deliveryId: string; event: string; payload: unknown; payloadSha256?: string; requestedBy?: string },
): Promise<DeliveryResult> {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const ctx = newContext(deps, input.deliveryId, input.event, input.payload, input.requestedBy);
  // Resolve the owning org up front so the delivery (and a failure) is visible to it.
  if (ctx.installationId !== undefined) await linkedInstallation(db, deps.host, ctx, ctx.installationId);

  const claim = await claimDelivery(db, {
    deliveryId: input.deliveryId,
    event: input.event,
    action: ctx.action,
    installationId: ctx.installationId,
    orgId: ctx.orgId,
    payloadSha256: input.payloadSha256,
    now: now(),
  });
  if (claim.kind === "duplicate") {
    ctx.log.info("duplicate delivery skipped", { previous: claim.status });
    return { status: "duplicate" };
  }
  if (claim.kind === "in_flight") {
    ctx.log.info("delivery already in flight");
    return { status: "duplicate", inFlight: true };
  }
  if (claim.kind === "retry") ctx.log.warn("reprocessing delivery", { attempts: claim.attempts });

  const started = performance.now();
  try {
    const outcome = await routeGitHubEvent(deps, input.event, input.payload, ctx);
    const durationMs = Math.round(performance.now() - started);
    await finishDelivery(db, input.deliveryId, {
      status: outcome.status,
      reason: outcome.status === "ignored" ? outcome.reason : undefined,
      jobs: outcome.status === "accepted" ? outcome.jobs : [],
      orgId: ctx.orgId,
      installationId: ctx.installationId,
      repoId: ctx.repoId,
      repoFullName: ctx.repoFullName,
      durationMs,
      now: now(),
    });
    ctx.log.info("webhook processed", {
      status: outcome.status,
      ...(outcome.status === "ignored" ? { reason: outcome.reason } : { jobs: outcome.jobs }),
      attempts: claim.attempts,
      durationMs,
    });
    return outcome;
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const error = errorMessage(err);
    ctx.log.error("webhook processing failed", { error, attempts: claim.attempts, durationMs });
    try {
      await failDelivery(db, input.deliveryId, {
        error,
        payload: input.payload,
        orgId: ctx.orgId,
        installationId: ctx.installationId,
        repoId: ctx.repoId,
        repoFullName: ctx.repoFullName,
        durationMs,
        now: now(),
      });
    } catch (recordErr) {
      ctx.log.error("could not record webhook failure", { error: errorMessage(recordErr) });
    }
    return { status: "failed", error };
  }
}

export type ReplayResult = DeliveryResult | { status: "not_found" } | { status: "not_replayable"; reason: string };

/**
 * Re-routes a failed delivery from its stored (redacted) payload, for the dashboard's "retry" (R6.21). Only the
 * org that owns the delivery can replay it, and only while its installation still belongs to that org.
 */
export async function replayDelivery(
  deps: RouteDeps,
  orgId: string,
  deliveryId: string,
  opts: { requestedBy?: string } = {},
): Promise<ReplayResult> {
  const row = await getDelivery(deps.db, orgId, deliveryId);
  if (!row) return { status: "not_found" };
  if (row.status !== "failed") return { status: "not_replayable", reason: `delivery is ${row.status}` };
  if (row.payload === null || row.payload === undefined) return { status: "not_replayable", reason: "payload was not kept" };
  if (row.installationId !== null) {
    const owner = await findInstallationByExternalId(deps.db, deps.host.provider, row.installationId);
    if (owner && owner.orgId !== orgId) return { status: "not_replayable", reason: "installation belongs to another organization" };
  }
  return processDelivery(deps, {
    deliveryId,
    event: row.event,
    payload: row.payload,
    payloadSha256: row.payloadSha256 ?? undefined,
    requestedBy: opts.requestedBy,
  });
}

const DELIVERY_ID = /^[\w.-]{1,128}$/;

/**
 * Webhook receiver (R1.2): verifies the signature (nothing is stored for a bad one), then processes the delivery
 * once. Accepted → 202, ignored or duplicate → 200, duplicate still in flight → 202, failure → 500 so GitHub retries.
 */
export function createGitHubWebhookHandler(getDeps: () => WebhookDeps) {
  return async function POST(req: Request): Promise<Response> {
    const deps = getDeps();
    const logger = deps.log ?? rootLog;
    const raw = await req.text();
    const deliveryId = req.headers.get("x-github-delivery");
    if (!verifyGitHubSignature(deps.secret, raw, req.headers.get("x-hub-signature-256"))) {
      logger.warn("webhook signature rejected", { deliveryId: deliveryId ?? undefined });
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }
    const event = req.headers.get("x-github-event");
    if (!event || !deliveryId) return Response.json({ error: "missing event headers" }, { status: 400 });
    if (!DELIVERY_ID.test(deliveryId) || !/^[a-z_]{1,64}$/.test(event)) {
      return Response.json({ error: "invalid event headers" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      logger.warn("webhook body is not JSON", { deliveryId, event });
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }

    const payloadSha256 = createHash("sha256").update(raw).digest("hex");
    let result: DeliveryResult;
    try {
      result = await processDelivery(deps, { deliveryId, event, payload, payloadSha256 });
    } catch (err) {
      // The delivery could not even be recorded (e.g. the database is down); GitHub will retry it.
      logger.error("webhook delivery could not be recorded", { deliveryId, event, error: errorMessage(err) });
      return Response.json({ status: "failed", deliveryId }, { status: 500 });
    }
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
  };
}
