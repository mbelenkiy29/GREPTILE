/**
 * Bitbucket Cloud webhook receiver and routing (R3.6). Each repository hook OpenReview creates has its own random
 * secret; Bitbucket signs the raw body with it (`X-Hub-Signature: sha256=<hex HMAC-SHA256>`). The hook is found by
 * `X-Hook-UUID`, the signature is checked in constant time with the decrypted secret, and the payload must be about
 * that hook's repository; nothing is stored for a delivery that fails (401). Deliveries are deduped by
 * `X-Request-UUID`.
 *
 * Routing: `pullrequest:created` / `pullrequest:updated` (new head only) → review; `pullrequest:fulfilled` /
 * `pullrequest:rejected` → feedback and rule mining; `pullrequest:comment_created` → mention answers in the comment's
 * thread, feedback for replies to OpenReview's comments; `repo:push` to the default branch → index.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BitbucketHost, bitbucketRepoId, normalizeUuid } from "@/lib/bitbucket/client";
import { hostFor } from "@/lib/git/hosts";
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

/** Verifies `X-Hub-Signature` (`sha256=` + hex HMAC-SHA256 of the raw body) in constant time. */
export function verifyBitbucketSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signBitbucketPayload(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}


const account = z.object({ uuid: z.string().nullish(), nickname: z.string().nullish(), display_name: z.string().nullish() }).nullish();
const login = (a: z.infer<typeof account>) => a?.nickname ?? a?.display_name ?? "";

const repoRef = z.object({ repository: z.object({ uuid: z.string() }) });
const prPayload = z.object({ actor: account, pullrequest: z.object({ id: z.number() }) });
const commentPayload = z.object({
  actor: account,
  pullrequest: z.object({ id: z.number() }),
  comment: z.object({
    id: z.number(),
    content: z.object({ raw: z.string().nullish() }).nullish(),
    user: account,
    inline: z.object({ path: z.string(), to: z.number().nullish() }).nullish(),
    parent: z.object({ id: z.number() }).nullish(),
  }),
});
const pushPayload = z.object({
  push: z.object({
    changes: z
      .array(z.object({ new: z.object({ type: z.string(), name: z.string(), target: z.object({ hash: z.string() }).nullish() }).nullish() }))
      .default([]),
  }),
});

function parse<S extends z.ZodType>(schema: S, payload: unknown, ctx: ScmContext): z.infer<S> | undefined {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  ctx.log.warn("malformed webhook payload", { issue: result.error.issues[0]?.message });
  return undefined;
}

function bitbucketHost(deps: ScmWebhookDeps): BitbucketHost {
  const host = hostFor(deps.host, "bitbucket");
  if (!(host instanceof BitbucketHost)) throw new Error("the bitbucket host is not a BitbucketHost");
  return host;
}

const fromUs = (target: ScmTarget, a: z.infer<typeof account>) => Boolean(target.credential.accountId && a?.uuid && a.uuid === target.credential.accountId);

async function onPullRequest(deps: ScmWebhookDeps, event: string, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  const p = parse(prPayload, payload, ctx);
  if (!p) return ignored("malformed pull request payload");
  const id = p.pullrequest.id;
  ctx.prNumber = id;
  ctx.log = ctx.log.child({ prNumber: id });
  if (event === "pullrequest:fulfilled" || event === "pullrequest:rejected") return closedPullRequest(deps, ctx, target, id);
  if (fromUs(target, p.actor)) return ignored("event sent by OpenReview");
  if (event === "pullrequest:created") return reviewPullRequest(deps, ctx, target, { prNumber: id, trigger: "opened" });
  return reviewPullRequest(deps, ctx, target, { prNumber: id, trigger: "synchronize", skipIfReviewed: true });
}

async function onComment(deps: ScmWebhookDeps, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  const p = parse(commentPayload, payload, ctx);
  if (!p) return ignored("malformed comment payload");
  const prId = p.pullrequest.id;
  ctx.prNumber = prId;
  ctx.log = ctx.log.child({ prNumber: prId });
  const c = p.comment;
  const body = c.content?.raw ?? "";
  if (isOwnComment(body) || fromUs(target, c.user) || fromUs(target, p.actor)) return ignored("comment by OpenReview");

  const api = await bitbucketHost(deps).api(target.installation.externalId);
  // Replies nest arbitrarily: the thread is addressed by its top-level comment.
  let root = { id: c.id, inline: c.inline ?? null, parent: c.parent ?? null };
  for (let hops = 0; root.parent && hops < 20; hops++) {
    const up = await api.getComment(target.repo.fullName, prId, root.parent.id);
    root = { id: up.id, inline: up.inline ?? null, parent: up.parent ?? null };
  }
  const threaded = Boolean(c.parent) || Boolean(c.inline);
  const inline = c.inline ?? root.inline;
  const addressed = addressesBot(body, deps.botMention);
  let authorAssociation: string | undefined;
  if (addressed && c.user?.uuid) {
    try {
      const member = await api.isWorkspaceMember(c.user.uuid);
      authorAssociation = member === null ? undefined : member ? "MEMBER" : "NONE";
    } catch (err) {
      ctx.log.info("could not read the commenter's workspace membership", { error: errorMessage(err) });
    }
  }
  return onPullRequestComment(
    deps,
    ctx,
    target,
    {
      prNumber: prId,
      id: c.id,
      body,
      author: login(c.user ?? p.actor),
      ...(threaded ? { threadRoot: root.id } : {}),
      ...(inline?.path ? { path: inline.path } : {}),
      line: inline?.to ?? null,
      inline: Boolean(c.inline),
      ...(authorAssociation ? { authorAssociation } : {}),
    },
    addressed,
  );
}

async function onPush(deps: ScmWebhookDeps, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  const p = parse(pushPayload, payload, ctx);
  if (!p) return ignored("malformed push payload");
  const change = p.push.changes.find((ch) => ch.new?.type === "branch" && ch.new.name === target.repo.defaultBranch);
  if (!change?.new) return ignored("not the default branch");
  return onDefaultBranchPush(deps, ctx, target, { branch: change.new.name, after: change.new.target?.hash ?? null });
}

/** Routes one verified Bitbucket event (`X-Event-Key`). */
export async function routeBitbucketEvent(deps: ScmWebhookDeps, event: string, payload: unknown, ctx: ScmContext, target: ScmTarget): Promise<RouteOutcome> {
  switch (event) {
    case "pullrequest:created":
    case "pullrequest:updated":
    case "pullrequest:fulfilled":
    case "pullrequest:rejected":
      return onPullRequest(deps, event, payload, ctx, target);
    case "pullrequest:comment_created":
      return onComment(deps, payload, ctx, target);
    case "repo:push":
      return onPush(deps, payload, ctx, target);
    default:
      return ignored(`unhandled event ${event}`);
  }
}

/** Replays a failed Bitbucket delivery of the org (R6.21). */
export function replayBitbucketDelivery(deps: ScmWebhookDeps, orgId: string, deliveryId: string, opts: { requestedBy?: string } = {}) {
  return replayScmDelivery(deps, routeBitbucketEvent, "bitbucket", orgId, deliveryId, opts);
}

const unauthorized = () => Response.json({ error: "invalid signature" }, { status: 401 });

/** The Bitbucket webhook route handler (`POST /api/webhooks/bitbucket`). */
export function createBitbucketWebhookHandler(getDeps: () => ScmWebhookDeps) {
  return async function POST(req: Request): Promise<Response> {
    const deps = getDeps();
    const logger = (deps.log ?? rootLog).child({ provider: "bitbucket" });
    const hookUuid = req.headers.get("x-hook-uuid");
    const raw = await req.text();
    if (!hookUuid || hookUuid.length > 64) return unauthorized();
    const hook = await repoHook(deps.db, "bitbucket", { externalHookId: normalizeUuid(hookUuid) });
    const secret = hook ? hookSecret(hook) : null;
    if (!hook || secret === null || !verifyBitbucketSignature(secret, raw, req.headers.get("x-hub-signature"))) {
      logger.warn("webhook signature rejected");
      return unauthorized();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const target = await hookTarget(deps.db, hook);
    const repo = repoRef.safeParse(payload);
    let repoId: number | null = null;
    try {
      repoId = repo.success ? bitbucketRepoId(repo.data.repository.uuid) : null;
    } catch {
      repoId = null;
    }
    // The signature proves the hook; the payload must also be about that hook's repository.
    if (!target || repoId === null || repoId !== target.repo.externalId) {
      logger.warn("webhook payload does not match its hook", { hookId: hook.id });
      return unauthorized();
    }
    const event = req.headers.get("x-event-key") ?? "";
    if (!/^[a-z_]{1,32}:[a-z_]{1,32}$/.test(event)) return Response.json({ error: "invalid event header" }, { status: 400 });
    const payloadSha256 = createHash("sha256").update(raw).digest("hex");
    const deliveryId = deliveryIdFrom(req.headers.get("x-request-uuid"), payloadSha256);
    let result: DeliveryResult;
    try {
      result = await processScmDelivery(deps, routeBitbucketEvent, { provider: "bitbucket", deliveryId, event, payload, payloadSha256, target });
    } catch (err) {
      logger.error("webhook delivery could not be recorded", { deliveryId, error: errorMessage(err) });
      return Response.json({ status: "failed", deliveryId }, { status: 500 });
    }
    return deliveryResponse(result, deliveryId);
  };
}
