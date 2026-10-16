import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { rateLimit } from "./rateLimit";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { threadReplyLimits } from "../src/thread-replies";
// The OpenReview comment that started a thread in this pull request, if any.
async function threadComment(ctx:QueryCtx,repositoryId:Id<"repositories">,prNumber:number,commentId:number|string){
 for(const comment of await ctx.db.query("reviewComments").withIndex("by_github",q=>q.eq("githubId",commentId)).take(20)){
  const review=await ctx.db.get(comment.reviewId);
  if(review?.repositoryId===repositoryId&&review.prNumber===prNumber)return comment;
 }
 return null;
}
export const ownsThread=internalQuery({args:{repositoryId:v.id("repositories"),prNumber:v.number(),commentId:v.number()},handler:async(ctx,a)=>!!await threadComment(ctx,a.repositoryId,a.prNumber,a.commentId)});
// A reply without a mention is answered only when it continues a thread OpenReview started, has
// not been answered before and stays within per-thread and per-pull-request hourly limits.
export const admitThreadReply=internalMutation({args:{repositoryId:v.id("repositories"),prNumber:v.number(),commentId:v.number(),parentCommentId:v.number()},handler:async(ctx,a)=>{
 const repo=await ctx.db.get(a.repositoryId);if(!repo?.enabled)return false;
 if(!await threadComment(ctx,repo._id,a.prNumber,a.parentCommentId))return false;
 if(await ctx.db.query("conversations").withIndex("by_repository_comment",q=>q.eq("repositoryId",repo._id).eq("githubCommentId",a.commentId)).unique())return false;
 try{
  // Thread first, so a reply refused by its thread's limit does not use the pull request's budget.
  await rateLimit(ctx,`thread-reply:${repo._id}:${a.prNumber}:${a.parentCommentId}`,threadReplyLimits.perThread,threadReplyLimits.windowMs);
  await rateLimit(ctx,`thread-reply:${repo._id}:${a.prNumber}`,threadReplyLimits.perPullRequest,threadReplyLimits.windowMs);
 }catch{return false;}
 return true;
}});
export const requestReview=internalMutation({args:{repositoryId:v.id("repositories"),prNumber:v.number(),commentId:v.union(v.number(),v.string()),author:v.string(),question:v.string(),headSha:v.string(),revisionKey:v.optional(v.string()),category:v.optional(v.string()),triggerComment:v.optional(v.object({id:v.number(),inline:v.boolean()}))},handler:async(ctx,a):Promise<Id<"reviews">|null>=>{
 const repo=await ctx.db.get(a.repositoryId);if(!repo?.enabled)throw new Error("Repository disabled");
 const previous=await ctx.db.query("conversations").withIndex("by_repository_comment",q=>q.eq("repositoryId",a.repositoryId).eq("githubCommentId",a.commentId)).unique();if(previous)return null;
 await rateLimit(ctx,`conversation:${repo.organizationId}`,20);
 const reviewId=await ctx.runMutation(internal.reviews.enqueue,{repositoryId:a.repositoryId,prNumber:a.prNumber,headSha:a.headSha,revisionKey:a.revisionKey,category:a.category,force:true,trigger:"mention",...(a.triggerComment?{triggerComment:a.triggerComment}:{})});
 await ctx.db.insert("conversations",{organizationId:repo.organizationId,repositoryId:a.repositoryId,prNumber:a.prNumber,githubCommentId:a.commentId,author:a.author,question:a.question.slice(0,8000),inline:false,status:"completed",answer:"Requested a new review of the current revision.",createdAt:Date.now(),updatedAt:Date.now(),attempts:1});return reviewId;
}});

export const begin = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    prNumber: v.number(),
    commentId: v.union(v.number(),v.string()),
    author: v.string(),
    question: v.string(),
    inline: v.boolean(),
    parentCommentId: v.optional(v.union(v.number(),v.string())),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository missing");
    const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
    if(connection?.kind==="perforce")throw new Error("Native P4 conversations use the authorized native worker");
    const previous = await ctx.db
      .query("conversations")
      .withIndex("by_repository_comment", (q) => q.eq("repositoryId", args.repositoryId).eq("githubCommentId", args.commentId))
      .unique();
    if (previous) {
      if (
        previous.status === "completed" ||
        (previous.status === "answering" &&
          (previous.updatedAt ?? previous.createdAt) >
            Date.now() - 15 * 60000) ||
        (previous.attempts ?? 1) >= 3
      )
        return null;
      await ctx.db.patch(previous._id, {
        status: "answering",
        attempts: (previous.attempts ?? 1) + 1,
        updatedAt: Date.now(),
      });
      return { ...previous, status: "answering" };
    }
    await rateLimit(ctx, `conversation:${repo.organizationId}`, 20);
    const id = await ctx.db.insert("conversations", {
      organizationId: repo.organizationId,
      repositoryId: repo._id,
      prNumber: args.prNumber,
      githubCommentId: args.commentId,
      author: args.author,
      question: args.question.slice(0, 8000),
      status: "answering",
      inline: args.inline,
      parentCommentId: args.parentCommentId,
      attempts: 1,
      updatedAt: Date.now(),
      createdAt: Date.now(),
    });
    return ctx.db.get(id);
  },
});
export const context = internalQuery({
  args: { repositoryId: v.id("repositories"), prNumber: v.number() },
  handler: async (ctx, args) => ({
    reviews: await ctx.db
      .query("reviews")
      .withIndex("by_pr", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("prNumber", args.prNumber),
      )
      .order("desc")
      .take(5),
    findings: await ctx.db
      .query("findings")
      .withIndex("by_pr", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("prNumber", args.prNumber),
      )
      .take(100),
    conversations: await ctx.db
      .query("conversations")
      .withIndex("by_pr", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("prNumber", args.prNumber),
      )
      .order("desc")
      .take(10),
  }),
});
export const finish = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    answer: v.optional(v.string()),
    error: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return;
    if(conversation.nativeP4)throw new Error("Native P4 conversations require their worker lease");
    await ctx.db.patch(args.conversationId, {
      ...(args.answer !== undefined ? { answer: args.answer } : {}),
      error: args.error,
      status: args.status,
      updatedAt: Date.now(),
    });
    if (args.status === "failed" && (conversation.attempts ?? 1) < 3)
      await ctx.scheduler.runAfter(
        10000 * (conversation.attempts ?? 1),
        internal.conversationJobs.reply,
        {
          repositoryId: conversation.repositoryId,
          prNumber: conversation.prNumber,
          commentId: conversation.githubCommentId,
          author: conversation.author,
          question: conversation.question,
          inline: conversation.inline ?? false,
          parentCommentId: conversation.parentCommentId,
        },
      );
  },
});
export const target = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    prNumber: v.number(),
    commentId: v.union(v.number(),v.string()),
  },
  handler: async (ctx, args) => {
    const comment = await threadComment(ctx, args.repositoryId, args.prNumber, args.commentId);
    if (!comment?.fingerprint) return null;
    return ctx.db
      .query("findings")
      .withIndex("by_fingerprint", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("prNumber", args.prNumber)
          .eq("fingerprint", comment.fingerprint!),
      )
      .first();
  },
});
export const preference = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    instruction: v.string(),
    author: v.string(),
    category: v.string(),
    findingId:v.id("findings"),
    conversationId:v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    const finding=await ctx.db.get(args.findingId),conversation=await ctx.db.get(args.conversationId);
    if (!repo?.enabled || !args.instruction.trim()||args.instruction.length > 2000||finding?.repositoryId!==repo._id||finding.organizationId!==repo.organizationId||finding.category!==args.category||conversation?.repositoryId!==repo._id||conversation.organizationId!==repo.organizationId||conversation.author!==args.author||conversation.prNumber!==finding.prNumber||!/@openreview\s+ignore\s+this\s+pattern/i.test(conversation.question))
      throw new Error("Invalid preference");
    const source="conversation:"+conversation._id;
    const existing=await ctx.db.query("learnedPreferences").withIndex("by_source",q=>q.eq("repositoryId",repo._id).eq("source",source)).unique();if(existing)return existing._id;
    return ctx.db.insert("learnedPreferences", {
      organizationId: repo.organizationId,
      repositoryId: repo._id,
      category: args.category,
      instruction: args.instruction,
      source,
      findingId:finding._id,
      sourceReviewId:finding.reviewId,
      conversationId:conversation._id,
      enabled: true,
      createdAt: Date.now(),
      updatedAt:Date.now(),
    });
  },
});
