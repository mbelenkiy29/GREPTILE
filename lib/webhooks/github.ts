import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { humanReviewComments, installations, repos, reviewComments, webhookDeliveries } from "@/lib/db/schema";
import { findInstallationByExternalId, syncInstallationRepos } from "@/lib/data/installations";
import type { GitHost } from "@/lib/git/types";
import { enqueueIndexForNewRepos } from "@/lib/jobs/enqueue";
import type { JobQueue } from "@/lib/jobs/types";
import { verifyGitHubSignature } from "./signature";

export interface WebhookDeps {
  db: Db;
  queue: JobQueue;
  host: GitHost;
  secret: string;
  botMention: string;
}

export type WebhookOutcome =
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "accepted"; jobs: string[] };

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/* eslint-disable @typescript-eslint/no-explicit-any -- webhook payloads are validated field by field */

export function mentionsBot(body: string, bot: string): boolean {
  const name = bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w/@-])@${name}(?![\\w-])`, "i").test(body);
}

async function repoFor(db: Db, host: GitHost, payload: any) {
  const installationId = payload?.installation?.id;
  const repoId = payload?.repository?.id;
  if (typeof installationId !== "number" || typeof repoId !== "number") return undefined;
  const [row] = await db
    .select({ repo: repos })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(
      and(
        eq(installations.provider, host.provider),
        eq(installations.externalId, installationId),
        eq(repos.externalId, repoId),
      ),
    );
  return row?.repo;
}

/** Routes one verified GitHub event to jobs. Job ids are deterministic so re-enqueueing is a no-op. */
export async function routeGitHubEvent(deps: WebhookDeps, event: string, payload: any): Promise<WebhookOutcome> {
  const { db, queue, host } = deps;

  if (event === "pull_request" && payload.action === "closed") {
    // Reactions have no webhook; collect feedback on our comments once the PR is done (R2.4).
    const repo = await repoFor(db, host, payload);
    if (!repo) return { status: "ignored", reason: "repository not connected" };
    const prNumber = payload.pull_request.number;
    const jobId = `feedback-${repo.id}-${prNumber}-closed`;
    await queue.add("sync-feedback", { orgId: repo.orgId, repoId: repo.id, prNumber }, { jobId });
    // Teammates' comments on the finished PR may hold conventions worth turning into rules (R2.5).
    const mineId = `mine-${repo.id}-${prNumber}`;
    await queue.add("mine-rules", { orgId: repo.orgId, repoId: repo.id }, { jobId: mineId });
    return { status: "accepted", jobs: [jobId, mineId] };
  }

  if (event === "pull_request_review_comment") {
    if (payload.action !== "created") return { status: "ignored", reason: `pull_request_review_comment.${payload.action}` };
    const comment = payload.comment;
    if (comment?.user?.type === "Bot") return { status: "ignored", reason: "comment by a bot" };
    const repo = await repoFor(db, host, payload);
    if (!repo) return { status: "ignored", reason: "repository not connected" };
    const prNumber = payload.pull_request?.number;
    if (comment?.in_reply_to_id) {
      const [ours] = await db
        .select({ id: reviewComments.id })
        .from(reviewComments)
        .where(and(eq(reviewComments.orgId, repo.orgId), eq(reviewComments.externalId, comment.in_reply_to_id)));
      if (ours) {
        const jobId = `feedback-${repo.id}-${prNumber}-${comment.id}`;
        await queue.add("sync-feedback", { orgId: repo.orgId, repoId: repo.id, prNumber }, { jobId });
        return { status: "accepted", jobs: [jobId] };
      }
    }
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
        body: String(comment.body ?? "").slice(0, 8000),
      })
      .onConflictDoNothing();
    return { status: "accepted", jobs: [] };
  }

  if (event === "pull_request") {
    if (!PR_ACTIONS.has(payload.action)) return { status: "ignored", reason: `pull_request.${payload.action}` };
    const pr = payload.pull_request;
    if (pr?.draft) return { status: "ignored", reason: "draft pull request" };
    const repo = await repoFor(db, host, payload);
    if (!repo) return { status: "ignored", reason: "repository not connected" };
    if (!repo.enabled) return { status: "ignored", reason: "reviews disabled for repository" };
    const jobId = `review-${repo.id}-${pr.number}-${pr.head.sha}`;
    await queue.add(
      "review-pr",
      { orgId: repo.orgId, repoId: repo.id, prNumber: pr.number, headSha: pr.head.sha },
      { jobId },
    );
    return { status: "accepted", jobs: [jobId] };
  }

  if (event === "issue_comment") {
    if (payload.action !== "created") return { status: "ignored", reason: `issue_comment.${payload.action}` };
    const comment = payload.comment;
    if (!payload.issue?.pull_request) return { status: "ignored", reason: "comment is not on a pull request" };
    if (comment?.user?.type === "Bot") return { status: "ignored", reason: "comment by a bot" };
    if (!mentionsBot(comment?.body ?? "", deps.botMention)) return { status: "ignored", reason: "no mention" };
    const repo = await repoFor(db, host, payload);
    if (!repo) return { status: "ignored", reason: "repository not connected" };
    const jobId = `mention-${repo.id}-${comment.id}`;
    await queue.add(
      "answer-mention",
      {
        orgId: repo.orgId,
        repoId: repo.id,
        prNumber: payload.issue.number,
        commentId: comment.id,
        body: comment.body,
        author: comment.user?.login ?? "",
      },
      { jobId },
    );
    return { status: "accepted", jobs: [jobId] };
  }

  if (event === "push") {
    const repo = await repoFor(db, host, payload);
    if (!repo) return { status: "ignored", reason: "repository not connected" };
    if (payload.ref !== `refs/heads/${repo.defaultBranch}`) return { status: "ignored", reason: "not the default branch" };
    if (payload.deleted || /^0+$/.test(payload.after ?? "")) return { status: "ignored", reason: "branch deleted" };
    const jobId = `index-${repo.id}-${payload.after}`;
    await queue.add(
      "index-repo",
      { orgId: repo.orgId, repoId: repo.id, mode: repo.indexedSha ? "incremental" : "full", afterSha: payload.after },
      { jobId },
    );
    return { status: "accepted", jobs: [jobId] };
  }

  if (event === "installation" || event === "installation_repositories") {
    const installation = await findInstallationByExternalId(db, host.provider, payload?.installation?.id);
    if (!installation) return { status: "ignored", reason: "installation not linked to an org" };
    if (event === "installation" && payload.action === "deleted") {
      await db.delete(installations).where(eq(installations.id, installation.id));
      return { status: "accepted", jobs: [] };
    }
    if (event === "installation" && (payload.action === "suspend" || payload.action === "unsuspend")) {
      await db
        .update(installations)
        .set({ suspended: payload.action === "suspend" })
        .where(eq(installations.id, installation.id));
      return { status: "accepted", jobs: [] };
    }
    const synced = await syncInstallationRepos(db, host, installation);
    await enqueueIndexForNewRepos(synced, queue);
    return { status: "accepted", jobs: [] };
  }

  return { status: "ignored", reason: `unhandled event ${event}` };
}

/**
 * Webhook receiver (R1.2): verifies the signature, drops redeliveries by
 * delivery id, and enqueues jobs. The delivery is recorded only after routing
 * succeeds, so a failed attempt can be retried by GitHub.
 */
export function createGitHubWebhookHandler(getDeps: () => WebhookDeps) {
  return async function POST(req: Request): Promise<Response> {
    const deps = getDeps();
    const raw = await req.text();
    if (!verifyGitHubSignature(deps.secret, raw, req.headers.get("x-hub-signature-256"))) {
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }
    const event = req.headers.get("x-github-event");
    const deliveryId = req.headers.get("x-github-delivery");
    if (!event || !deliveryId) return Response.json({ error: "missing event headers" }, { status: 400 });

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }

    const [seen] = await deps.db
      .select({ id: webhookDeliveries.deliveryId })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
    if (seen) return Response.json({ status: "duplicate" }, { status: 200 });

    const outcome = await routeGitHubEvent(deps, event, payload);
    await deps.db
      .insert(webhookDeliveries)
      .values({ deliveryId, event, action: typeof payload?.action === "string" ? payload.action : null })
      .onConflictDoNothing();
    return Response.json(outcome, { status: outcome.status === "accepted" ? 202 : 200 });
  };
}
