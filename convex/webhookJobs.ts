"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { z } from "zod";
import { Github } from "../src/github";
import { pullRequestTrigger } from "../src/triggers";
import { wantsAnswer } from "../src/thread-replies";
import { labelTier, tiers } from "../src/review-tier";

const payloadSchema = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z
    .object({
      id: z.number(),
      full_name: z.string().optional(),
      default_branch: z.string().optional(),
    })
    .optional(),
  pull_request: z
    .object({
      number: z.number(),
      draft: z.boolean(),
      state: z.string(),
      head: z.object({ sha: z.string(), ref: z.string() }),
      base: z.object({ ref: z.string() }),
      user: z.object({ login: z.string() }).optional(),
      labels: z.array(z.object({ name: z.string() })).optional(),
    })
    .optional(),
  label: z.object({ name: z.string() }).optional(),
  issue: z
    .object({ number: z.number(), pull_request: z.unknown().optional() })
    .optional(),
  comment: z
    .object({
      id: z.number(),
      body: z.string(),
      in_reply_to_id: z.number().optional(),
      user: z.object({ login: z.string(), type: z.string() }),
      pull_request_url: z.string().optional(),
    })
    .optional(),
  review: z
    .object({
      id: z.number(),
      body: z.string().nullable(),
      user: z.object({ login: z.string(), type: z.string() }),
    })
    .optional(),
  ref: z.string().optional(),
  repositories: z
    .array(
      z.object({
        id: z.number(),
        full_name: z.string(),
        default_branch: z.string().optional(),
      }),
    )
    .optional(),
  repositories_added: z
    .array(
      z.object({
        id: z.number(),
        full_name: z.string(),
        default_branch: z.string().optional(),
      }),
    )
    .optional(),
  repositories_removed: z
    .array(
      z.object({
        id: z.number(),
        full_name: z.string(),
        default_branch: z.string().optional(),
      }),
    )
    .optional(),
});
export const process = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    const delivery = await ctx.runQuery(internal.webhooks.data, args);
    if (!delivery || delivery.status === "completed") return;
    await ctx.runMutation(internal.webhooks.mark, {
      ...args,
      status: "processing",
    });
    const observedAt = Date.now();
    try {
      const blob = await ctx.storage.get(delivery.payloadStorageId);
      if (!blob) throw new Error("Webhook payload unavailable");
      const payload = payloadSchema.parse(JSON.parse(await blob.text()));
      const comment =
        payload.comment ??
        (delivery.event === "pull_request_review" && payload.review?.body
          ? {
              id: -payload.review.id,
              body: payload.review.body,
              user: payload.review.user,
              in_reply_to_id: undefined,
            }
          : undefined);
      if (
        delivery.event === "installation" ||
        delivery.event === "installation_repositories"
      ) {
        if (payload.installation) {
          await ctx.runMutation(internal.webhooks.installationEvent, {
            installationId: payload.installation.id,
            action: payload.action ?? "",
            repositories: (
              payload.repositories ??
              payload.repositories_added ??
              []
            ).map((r) => ({
              id: r.id,
              fullName: r.full_name,
              defaultBranch: r.default_branch ?? "main",
            })),
          });
          if (payload.repositories_removed?.length)
            await ctx.runMutation(internal.webhooks.installationEvent, {
              installationId: payload.installation.id,
              action: "removed",
              repositories: payload.repositories_removed.map((r) => ({
                id: r.id,
                fullName: r.full_name,
                defaultBranch: r.default_branch ?? "main",
              })),
            });
        }
      } else if (payload.repository) {
        const data = await ctx.runQuery(internal.webhooks.repository, {
          githubId: payload.repository.id,
        });
        if (
          data?.repo.enabled &&
          payload.installation?.id === data.repo.installationId
        ) {
          const { repo, settings } = data;
          if(payload.pull_request&&["pull_request","pull_request_review"].includes(delivery.event))
            await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:payload.pull_request.number});
          if (delivery.event === "pull_request" && payload.pull_request) {
            // Read current metadata rather than replaying a potentially stale webhook snapshot.
            // A metadata-only request must not require a complete reviewable diff.
            const github = await Github.installation(repo.installationId!);
            const pr = await github.changeMetadata(repo.fullName,payload.pull_request.number);
            payload.pull_request = {...payload.pull_request,state:pr.state,draft:pr.draft,head:pr.head,base:pr.base};
            await ctx.runMutation(internal.pulls.observe,{repositoryId:repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,observedAt});
          }
          if (
            delivery.event === "repository" ||
            (delivery.event === "pull_request" && payload.action === "closed")
          )
            await ctx.runMutation(internal.webhooks.lifecycle, {
              repositoryId: repo._id,
              action: payload.action ?? "",
              fullName: payload.repository.full_name,
              defaultBranch: payload.repository.default_branch,
              prNumber: payload.pull_request?.number,
              state: payload.pull_request?.state,
              observedAt,
            });
          if (
            delivery.event === "pull_request" &&
            payload.pull_request &&
            ["opened", "synchronize", "reopened", "ready_for_review", "labeled"].includes(
              payload.action ?? "",
            )
          ) {
            const pr = payload.pull_request;
            // openreview:<tier> labels request a tier and, like trigger labels, start reviews of labelled PRs.
            const tierLabel = labelTier((pr.labels ?? []).map((l) => l.name));
            const decision = settings ? pullRequestTrigger({ action: payload.action ?? "", label: payload.label?.name, pr }, { ...settings, triggerLabels: [...(settings.triggerLabels ?? []), ...tiers.map((t) => "openreview:" + t)] }) : { review: false as const, reason: "No settings" };
            if (decision.review)
              await ctx.runMutation(internal.reviews.enqueue, {
                repositoryId: repo._id,
                prNumber: pr.number,
                headSha: pr.head.sha,
                trigger: decision.trigger,
                ...(tierLabel ? { requestedMode: tierLabel, requestedModeSource: "label" as const } : {}),
              });
            else console.log(JSON.stringify({ event: "review.not_triggered", repositoryId: repo._id, prNumber: pr.number, action: payload.action, reason: decision.reason }));
          }
          if (
            delivery.event === "push" &&
            payload.ref === `refs/heads/${repo.defaultBranch}`
          )
            await ctx.scheduler.runAfter(0, internal.jobs.index, {
              repositoryId: repo._id,
            });
          if (
            [
              "issue_comment",
              "pull_request_review_comment",
              "pull_request_review",
            ].includes(delivery.event) &&
            ["created", "edited", "submitted"].includes(payload.action ?? "") &&
            comment &&
            comment.user.type !== "Bot" &&
            (/@openreview\b/i.test(comment.body) ||
              // A human reply in a review thread: answered without a mention only in OpenReview's own threads.
              (delivery.event === "pull_request_review_comment" && payload.action === "created" && comment.in_reply_to_id !== undefined && !comment.user.login.endsWith("[bot]") && settings?.threadReplies !== false && wantsAnswer(comment.body)))
          ) {
            const mentioned = /@openreview\b/i.test(comment.body);
            const number =
              payload.pull_request?.number ??
              (payload.issue?.pull_request ? payload.issue.number : undefined);
            // Unmentioned replies outside OpenReview's threads stop here, before any provider call.
            if (number && (mentioned || await ctx.runQuery(internal.conversations.ownsThread, { repositoryId: repo._id, prNumber: number, commentId: comment.in_reply_to_id! }))) {
              const github = await Github.installation(repo.installationId!);
              const permission = await github.request(
                `/repos/${repo.fullName}/collaborators/${encodeURIComponent(comment.user.login)}/permission`,
                z.object({ permission: z.string() }),
              );
              if (
                ["admin", "maintain", "write"].includes(permission.permission)
              ) {
                if (!mentioned) {
                  if (await ctx.runMutation(internal.conversations.admitThreadReply, { repositoryId: repo._id, prNumber: number, commentId: comment.id, parentCommentId: comment.in_reply_to_id! }))
                    await ctx.scheduler.runAfter(0, internal.conversationJobs.reply, { repositoryId: repo._id, prNumber: number, commentId: comment.id, author: comment.user.login, question: comment.body, inline: true, parentCommentId: comment.in_reply_to_id });
                } else if (
                  /@openreview\s+review(?:\s+again|\s+security)?\b/i.test(
                    comment.body,
                  )
                ) {
                  const pr = await github.pullRequest(repo.fullName, number);
                  if (pr.state === "open") await ctx.runMutation(internal.conversations.requestReview, {
                    repositoryId: repo._id,
                    prNumber: number,
                    commentId: comment.id,
                    author: comment.user.login,
                    question: comment.body,
                    headSha: pr.head.sha,
                    ...(/review\s+security/i.test(comment.body)
                      ? { category: "security" }
                      : {}),
                  });
                } else
                  await ctx.scheduler.runAfter(
                    0,
                    internal.conversationJobs.reply,
                    {
                      repositoryId: repo._id,
                      prNumber: number,
                      commentId: comment.id,
                      author: comment.user.login,
                      question: comment.body,
                      inline: delivery.event === "pull_request_review_comment",
                      parentCommentId: comment.in_reply_to_id,
                    },
                  );
              }
            }
          }
        }
      }
      await ctx.runMutation(internal.webhooks.mark, {
        ...args,
        status: "completed",
      });
    } catch (error) {
      await ctx.runMutation(internal.webhooks.mark, {
        ...args,
        status: "failed",
        error:
          error instanceof Error ? error.message : "Webhook processing failed",
      });
    }
  },
});
