/**
 * GitLab webhook receiver and routing (R3.6). Each project hook OpenReview creates has its own random secret, which
 * GitLab echoes in `X-Gitlab-Token`: the hash of the header finds the hook, the header is compared in constant time
 * with the decrypted secret, and the payload must be about that hook's project. Nothing is stored for a delivery that
 * fails verification (401). Deliveries are deduped by `Idempotency-Key` (GitLab 17.4+, stable across retries), then
 * `X-Gitlab-Event-UUID`, then the body hash.
 *
 * Routing: merge request open / reopen / new commits / marked ready → review; close / merge → feedback and rule
 * mining; a note that mentions the bot → answer in its discussion; a reply to an OpenReview diff note → feedback;
 * push to the default branch → index.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { hashToken, safeEqual } from "@/lib/crypto";
import { hostFor } from "@/lib/git/hosts";
import { GITLAB_DEVELOPER, GitLabHost } from "@/lib/gitlab/client";
import { addressesBot } from "@/lib/learning/commands";
import { errorMessage, log as rootLog } from "@/lib/log";
import {
  closedPullRequest,
  deliveryResponse,
  hookTarget,
  ignored,
  isOwnComment,
  onDefaultBranchPush,
  onPullRequestComment,
  processScmDelivery,
  replayScmDelivery,
  repoHook,
  reviewPullRequest,
  deliveryIdFrom,
  hookSecret,
  type DeliveryResult,
  type RouteOutcome,
  type ScmContext,
  type ScmTarget,
  type ScmWebhookDeps,
} from "./scm";

const actor = z.object({ id: z.number().optional(), username: z.string().optional() }).nullish();

const projectRef = z.object({ project: z.object({ id: z.number() }) });

const mergeRequestPayload = z.object({
  object_kind: z.literal("merge_request"),
  user: actor,
  object_attributes: z.object({
    iid: z.number(),
    action: z.string().nullish(),
    oldrev: z.string().nullish(),
  }),
  changes: z
    .object({
      draft: z.object({ previous: z.boolean().nullish(), current: z.boolean().nullish() }).nullish(),
      work_in_progress: z.object({ previous: z.boolean().nullish(), current: z.boolean().nullish() }).nullish(),
    })
    .nullish(),
});

const notePayload = z.object({
  object_kind: z.literal("note"),
  user: actor,
  object_attributes: z.object({
    id: z.number(),
    note: z.string().nullish(),
    noteable_type: z.string(),
    discussion_id: z.string().nullish(),
    type: z.string().nullish(),
    position: z.object({ new_path: z.string().nullish(), new_line: z.number().nullish(), old_path: z.string().nullish() }).nullish(),
  }),
  merge_request: z.object({ iid: z.number() }).nullish(),
});

const pushPayload = z.object({
  object_kind: z.literal("push"),
  ref: z.string(),
  after: z.string().nullish(),
  checkout_sha: z.string().nullish(),
  project: z.object({ default_branch: z.string().nullish() }).nullish(),
});

function parse<S extends z.ZodType>(schema: S, payload: unknown, ctx: ScmContext): z.infer<S> | undefined {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  ctx.log.warn("malformed webhook payload", { issue: result.error.issues[0]?.message });
  return undefined;
}

async function onMergeRequest(deps: ScmWebhookDeps, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  const p = parse(mergeRequestPayload, payload, ctx);
  if (!p) return ignored("malformed merge_request payload");
  const mr = p.object_attributes;
  ctx.prNumber = mr.iid;
  ctx.log = ctx.log.child({ prNumber: mr.iid });
  const action = mr.action ?? "";
  if (action === "close" || action === "merge") return closedPullRequest(deps, ctx, target, mr.iid);
  if (p.user?.username && target.credential.accountLogin && p.user.username === target.credential.accountLogin) return ignored("event sent by OpenReview");
  if (action === "open") return reviewPullRequest(deps, ctx, target, { prNumber: mr.iid, trigger: "opened" });
  if (action === "reopen") return reviewPullRequest(deps, ctx, target, { prNumber: mr.iid, trigger: "reopened" });
  if (action === "update") {
    // `oldrev` is present only when the update pushed new commits.
    if (mr.oldrev) return reviewPullRequest(deps, ctx, target, { prNumber: mr.iid, trigger: "synchronize" });
    const draft = p.changes?.draft ?? p.changes?.work_in_progress;
    if (draft?.previous === true && draft.current === false) return reviewPullRequest(deps, ctx, target, { prNumber: mr.iid, trigger: "ready_for_review" });
    return ignored("merge_request.update without new commits");
  }
  return ignored(`merge_request.${action || "unknown"}`);
}

function gitlabHost(deps: ScmWebhookDeps): GitLabHost {
  const host = hostFor(deps.host, "gitlab");
  if (!(host instanceof GitLabHost)) throw new Error("the gitlab host is not a GitLabHost");
  return host;
}

/** GitHub-style association from the project role: Developer and above can run state-changing commands. */
async function association(deps: ScmWebhookDeps, ctx: ScmContext, target: ScmTarget, userId: number | undefined): Promise<string | undefined> {
  if (userId === undefined) return undefined;
  try {
    const level = await (await gitlabHost(deps).api(target.installation.externalId)).memberAccessLevel(target.repo.externalId, userId);
    if (level === null) return "NONE";
    return level >= 50 ? "OWNER" : level >= GITLAB_DEVELOPER ? "MEMBER" : "CONTRIBUTOR";
  } catch (err) {
    ctx.log.info("could not read the commenter's project role", { error: errorMessage(err) });
    return undefined;
  }
}

async function onNote(deps: ScmWebhookDeps, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  const p = parse(notePayload, payload, ctx);
  if (!p) return ignored("malformed note payload");
  const note = p.object_attributes;
  if (note.noteable_type !== "MergeRequest" || !p.merge_request) return ignored("note is not on a merge request");
  const iid = p.merge_request.iid;
  ctx.prNumber = iid;
  ctx.log = ctx.log.child({ prNumber: iid });
  const body = note.note ?? "";
  if (isOwnComment(body) || (target.credential.accountLogin && p.user?.username === target.credential.accountLogin)) return ignored("comment by OpenReview");

  // A note in a thread (diff or not) is answered in that thread; the thread is addressed by its first note.
  let threadRoot: number | undefined;
  const threaded = note.type === "DiffNote" || note.type === "DiscussionNote";
  if (threaded && note.discussion_id) {
    const discussion = await (await gitlabHost(deps).api(target.installation.externalId)).getDiscussion(target.repo.externalId, iid, note.discussion_id);
    threadRoot = discussion.notes[0]?.id ?? note.id;
  }
  const addressed = addressesBot(body, deps.botMention);
  return onPullRequestComment(
    deps,
    ctx,
    target,
    {
      prNumber: iid,
      id: note.id,
      body,
      author: p.user?.username ?? "",
      ...(threadRoot !== undefined ? { threadRoot } : {}),
      ...(note.position?.new_path ? { path: note.position.new_path } : {}),
      line: note.position?.new_line ?? null,
      inline: note.type === "DiffNote",
      ...(addressed ? { authorAssociation: await association(deps, ctx, target, p.user?.id) } : {}),
    },
    addressed,
  );
}

async function onPush(deps: ScmWebhookDeps, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  const p = parse(pushPayload, payload, ctx);
  if (!p) return ignored("malformed push payload");
  if (!p.ref.startsWith("refs/heads/")) return ignored("not a branch push");
  return onDefaultBranchPush(deps, ctx, target, { branch: p.ref.slice("refs/heads/".length), after: p.checkout_sha ?? p.after ?? null });
}

/** Routes one verified GitLab event (by `object_kind`, which every hook payload carries). */
export async function routeGitLabEvent(deps: ScmWebhookDeps, event: string, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  const kind = typeof payload === "object" && payload !== null && "object_kind" in payload ? String((payload as { object_kind: unknown }).object_kind) : event;
  switch (kind) {
    case "merge_request":
      return onMergeRequest(deps, payload, ctx, target);
    case "note":
      return onNote(deps, payload, ctx, target);
    case "push":
      return onPush(deps, payload, ctx, target);
    default:
      return ignored(`unhandled event ${kind}`);
  }
}

/** Replays a failed GitLab delivery of the org (R6.21). */
export function replayGitLabDelivery(deps: ScmWebhookDeps, orgId: string, deliveryId: string, opts: { requestedBy?: string } = {}) {
  return replayScmDelivery(deps, routeGitLabEvent, "gitlab", orgId, deliveryId, opts);
}

const unauthorized = () => Response.json({ error: "invalid token" }, { status: 401 });

/** `X-Gitlab-Event: Merge Request Hook` → `merge_request_hook`. */
function eventName(header: string | null, payload: unknown): string {
  const kind = typeof payload === "object" && payload !== null && "object_kind" in payload ? String((payload as { object_kind: unknown }).object_kind) : "";
  const name = (header ?? kind).toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
  return name.slice(0, 64) || "unknown";
}

/** The GitLab webhook route handler (`POST /api/webhooks/gitlab`). */
export function createGitLabWebhookHandler(getDeps: () => ScmWebhookDeps) {
  return async function POST(req: Request): Promise<Response> {
    const deps = getDeps();
    const logger = (deps.log ?? rootLog).child({ provider: "gitlab" });
    const token = req.headers.get("x-gitlab-token");
    if (!token || token.length > 512) return unauthorized();
    const hook = await repoHook(deps.db, "gitlab", { secretHash: hashToken(token) });
    const secret = hook ? hookSecret(hook) : null;
    if (!hook || secret === null || !safeEqual(secret, token)) {
      logger.warn("webhook token rejected");
      return unauthorized();
    }
    const raw = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const target = await hookTarget(deps.db, hook);
    const project = projectRef.safeParse(payload);
    // The token proves the hook; the payload must also be about that hook's project.
    if (!target || !project.success || project.data.project.id !== target.repo.externalId) {
      logger.warn("webhook payload does not match its hook", { hookId: hook.id });
      return unauthorized();
    }
    const payloadSha256 = createHash("sha256").update(raw).digest("hex");
    const deliveryId = deliveryIdFrom(req.headers.get("idempotency-key") ?? req.headers.get("x-gitlab-event-uuid"), payloadSha256);
    const action =
      typeof payload === "object" && payload !== null && "object_attributes" in payload
        ? (payload as { object_attributes?: { action?: unknown } }).object_attributes?.action
        : undefined;
    let result: DeliveryResult;
    try {
      result = await processScmDelivery(deps, routeGitLabEvent, {
        provider: "gitlab",
        deliveryId,
        event: eventName(req.headers.get("x-gitlab-event"), payload),
        ...(typeof action === "string" ? { action } : {}),
        payload,
        payloadSha256,
        target,
      });
    } catch (err) {
      logger.error("webhook delivery could not be recorded", { deliveryId, error: errorMessage(err) });
      return Response.json({ status: "failed", deliveryId }, { status: 500 });
    }
    return deliveryResponse(result, deliveryId);
  };
}
