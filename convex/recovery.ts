import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {indexWriteAllowed} from "./indexAuthority";
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const cached of await ctx.db
      .query("modelCache")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(1000))
      await ctx.db.delete(cached._id);
    const stale = Date.now() - 15 * 60000;
    await ctx.runMutation(internal.p4Conversations.recover,{});
    // ponytail: bounded recovery scan; add a status index when workspaces exceed 1,000 repositories.
    for (const repo of await ctx.db.query("repositories").take(1000))
      if (
        ["queued", "generating"].includes(repo.knowledgeStatus ?? "") &&
        repo.indexStatus === "ready" &&
        (repo.knowledgeUpdatedAt ?? 0) < stale
      ) {
        if ((repo.knowledgeAttempt ?? 1) >= 3)
          await ctx.db.patch(repo._id, {
            knowledgeStatus: "failed",
            knowledgeError: "Knowledge recovery exhausted",
          });
        else
          await ctx.scheduler.runAfter(0, internal.knowledgeJobs.generate, {
            repositoryId: repo._id,
            paths: repo.knowledgePaths ?? [],
            attempt: (repo.knowledgeAttempt ?? 1) + 1,
          });
      }
    for (const conversation of await ctx.db
      .query("conversations")
      .withIndex("by_status", (q) => q.eq("status", "answering"))
      .take(100)) {
      if(conversation.nativeP4)continue;
      if ((conversation.updatedAt ?? conversation.createdAt) >= stale) continue;
      if ((conversation.attempts ?? 1) >= 3) {
        await ctx.db.patch(conversation._id, {
          status: "failed",
          error: "Reply recovery exhausted",
          updatedAt: Date.now(),
        });
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.conversationJobs.reply, {
        repositoryId: conversation.repositoryId,
        prNumber: conversation.prNumber,
        commentId: conversation.githubCommentId,
        author: conversation.author,
        question: conversation.question,
        inline: conversation.inline ?? false,
        parentCommentId: conversation.parentCommentId,
      });
    }
    for (const job of await ctx.db
      .query("indexJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(100)) {
      const repo=await ctx.db.get(job.repositoryId);
      if(!await indexWriteAllowed(ctx,repo,job)){await ctx.db.patch(job._id,{status:"cancelled",error:"Indexing authorization was revoked",updatedAt:Date.now()});if(repo&&["queued","indexing"].includes(repo.indexStatus))await ctx.db.patch(repo._id,{indexStatus:"cancelled",error:"Indexing authorization was revoked"});continue;}
      if (job.updatedAt >= stale) continue;
      if (job.attempts >= 3) {
        await ctx.db.patch(job._id, {
          status: "failed",
          error: "Index recovery attempts exhausted",
          updatedAt: Date.now(),
        });
        await ctx.db.patch(job.repositoryId, {
          indexStatus: "failed",
          error: "Index recovery attempts exhausted",
        });
        continue;
      }
      await ctx.db.patch(job._id, {
        attempts: job.attempts + 1,
        updatedAt: Date.now(),
      });
      if (job.manifestStorageId)
        await ctx.scheduler.runAfter(0, internal.jobs.indexBatch, {
          jobId: job._id,
        });
      else {
        await ctx.db.patch(job._id, { status: "failed" });
        await ctx.scheduler.runAfter(0, internal.jobs.index, {
          repositoryId: job.repositoryId,
        });
      }
    }
    for (const stage of [
      "queued",
      "ingesting",
      "retrieving_context",
      "reviewing",
      "verifying",
      "summarizing",
      "publishing",
    ]) {
      for (const review of await ctx.db
        .query("reviews")
        .withIndex("by_status", (q) => q.eq("status", stage))
        .take(100))
        if (review.updatedAt < stale) {
          if((review.nativeP4?.lease?.expiresAt??0)>Date.now())continue;
          if(review.retryScheduledId){
            const retry=await ctx.db.system.get(review.retryScheduledId);
            if(retry&&["pending","inProgress"].includes(retry.state.kind))continue;
          }
          if (review.attempts >= 3)
            await ctx.db.patch(review._id, {
              status: "failed",
              error: "Review recovery attempts exhausted",
              updatedAt: Date.now(),
              finishedAt: Date.now(),
              retryScheduledId: undefined,
              retryAt: undefined,
            });
          else {
            await ctx.db.patch(review._id, {
              status: "queued",
              updatedAt: Date.now(),
              finishedAt: undefined,
              retryScheduledId: undefined,
              retryAt: undefined,
            });
            await ctx.scheduler.runAfter(0, internal.jobs.review, {
              reviewId: review._id,
            });
          }
        }
    }
    for (const delivery of await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(100))
      if (delivery.updatedAt < stale && delivery.attempts < 3)
        await ctx.scheduler.runAfter(0, internal.webhookJobs.process, {
          deliveryId: delivery._id,
        });
  },
});
