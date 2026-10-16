import {executionExplanation} from "../src/execution-claims";
import { notificationsEnabled } from "./notifications";
import { reviewAllowance } from "./billing";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { authorize, authorizeRepository, visibleRepositories } from "./auth";
import type { Doc, Id } from "./_generated/dataModel";
import { recordSignals } from "./commitSignals";
import {p4FixAuthority} from "./p4FixAuthority";
import { eligibleFixFinding } from "../src/fix-prompt";
import { effectiveSettings } from "./scopes";
import { rateLimit } from "./rateLimit";
import {repositoryContextValidator,validateRepositoryContext,requireContextReader,contextReadable,requireFindingReader} from "./repositoryContext";
import {validateIntegrationScopes} from "./integrations";
import { runtimeEvidenceValidator, findingValidator } from "./schema";
import { redact } from "../src/redact";
import { runtimeEvidenceSchema, approvalAssessmentSchema, reviewScoreSchema } from "../src/engine/types";
import {p4AutomaticAuthority} from "./p4Polling";
import {cancelReview,requireP4Worker} from "./reviewLifecycle";
import {p4Baseline} from "./p4Index";
import {findingTags,priorityOf} from "../src/priority";

const usageValidator = v.object({
  task: v.string(),
  provider: v.string(),
  model: v.string(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  latencyMs: v.number(),
  estimatedCost: v.number(),
  cached: v.boolean(),
  cacheReadTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
});

export const enqueue = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    prNumber: v.number(),
    headSha: v.string(),
    revisionKey: v.optional(v.string()),
    force: v.optional(v.boolean()),
    category: v.optional(v.string()),
    runtimeEvidence: v.optional(runtimeEvidenceValidator),
    // How the review was requested: automatic/label reviews honour size limits; mention bypasses them.
    trigger: v.optional(v.union(v.literal("automatic"), v.literal("label"), v.literal("mention"), v.literal("manual"))),
    triggerComment: v.optional(v.object({ id: v.number(), inline: v.boolean() })),
    requestedMode: v.optional(v.union(v.literal("fast"),v.literal("standard"),v.literal("deep"))),
    requestedModeSource: v.optional(v.union(v.literal("comment"), v.literal("label"))),
  },
  handler: async (ctx, args) => {
    if (args.runtimeEvidence) {
      const runtimeEvidence = runtimeEvidenceSchema.parse(args.runtimeEvidence);
      if (runtimeEvidence.headSha !== args.headSha)
        throw new Error("Runtime evidence belongs to a different commit");
      args.runtimeEvidence = {
        ...runtimeEvidence,
        output: redact(runtimeEvidence.output),
      };
    }
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || !repo.enabled) return null;
    const previous = await ctx.db
      .query("reviews")
      .withIndex("by_head", (q) =>
        q
          .eq("repositoryId", repo._id)
          .eq("prNumber", args.prNumber)
          .eq("headSha", args.headSha),
      )
      .order("desc")
      .first();
    if (
      previous &&
      previous.revisionKey === args.revisionKey &&
      !args.force &&
      previous.status !== "failed" &&
      previous.status !== "cancelled"
    )
      return previous._id;
    await rateLimit(ctx, `review:${repo.organizationId}`, 20);
    const pending = await ctx.db
      .query("reviews")
      .withIndex("by_pr", (q) =>
        q.eq("repositoryId", repo._id).eq("prNumber", args.prNumber),
      )
      .order("desc")
      .take(100);
    for (const r of pending)
      if (!["completed", "failed", "cancelled"].includes(r.status))
        await cancelReview(ctx,r);
    const config = await effectiveSettings(ctx,repo);
    // Cloud billing quota (no-op when BILLING_ENABLED is unset): a blocked review is recorded
    // as failed with the billing reason instead of running.
    const allowance = await reviewAllowance(ctx, repo.organizationId);
    if (!allowance.allowed) {
      if (args.trigger && args.trigger !== "manual") await ctx.scheduler.runAfter(0, internal.jobs.billingNotice, { repositoryId: repo._id, prNumber: args.prNumber });
      return ctx.db.insert("reviews", { organizationId: repo.organizationId, repositoryId: repo._id, prNumber: args.prNumber, headSha: args.headSha, revisionKey: args.revisionKey, status: "failed", error: allowance.reason, mode: config.mode, ...(args.trigger ? { trigger: args.trigger } : {}), attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now() });
    }
    const reviewId = await ctx.db.insert("reviews", {
      organizationId: repo.organizationId,
      repositoryId: repo._id,
      prNumber: args.prNumber,
      headSha: args.headSha,
      revisionKey: args.revisionKey,
      status: "queued",
      mode: config.mode,
      category: args.category,
      ...(args.requestedMode ? { requestedMode: args.requestedMode, requestedModeSource: args.requestedModeSource ?? "comment" } : {}),
      runtimeEvidence: args.runtimeEvidence,
      ...(args.trigger ? { trigger: args.trigger } : {}),
      ...(args.triggerComment ? { triggerComment: args.triggerComment } : {}),
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(2000, internal.jobs.review, { reviewId });
    return reviewId;
  },
});
export const request = mutation({
  args: {
    token: v.string(),
    repositoryId: v.id("repositories"),
    prNumber: v.number(),
    headSha: v.string(),
    runtimeEvidence: v.optional(runtimeEvidenceValidator),
  },
  handler: async (ctx, args): Promise<Id<"reviews"> | null> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    await authorizeRepository(ctx, args.token, repo._id, true);
    if (args.runtimeEvidence)
      throw new Error("Runtime evidence must be reported by a paired runtime worker, not supplied in a review request");
    if (
      !Number.isInteger(args.prNumber) ||
      args.prNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(args.headSha)
    )
      throw new Error("Invalid PR or SHA");
    return ctx.runMutation(internal.reviews.enqueue, {
      repositoryId: repo._id,
      prNumber: args.prNumber,
      headSha: args.headSha,
      force: true,
      trigger: "manual",
    });
  },
});
export const stage = internalMutation({
  args: {
    reviewId: v.id("reviews"),
    status: v.string(),
    detail: v.optional(v.string()),
    workerLease: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review || review.status === "cancelled")
      throw new Error("Review cancelled");
    if(args.status!=="ingesting")requireP4Worker(review,args.workerLease);
    if (
      args.status === "ingesting" &&
      !["queued", "failed", "waiting_runtime", "waiting_agent"].includes(review.status)
    )
      return false;
    if(args.status==="ingesting"&&review.retryScheduledId){
      const retry=await ctx.db.system.get(review.retryScheduledId);
      if(retry?.state.kind==="pending")await ctx.scheduler.cancel(retry._id);
    }
    if(args.status === "cancelled")await cancelReview(ctx,review);
    else await ctx.db.patch(review._id, {
      status: args.status,
      updatedAt: Date.now(),
      ...(args.status === "ingesting" ? {error:undefined,finishedAt:undefined,retryScheduledId:undefined,retryAt:undefined} : {}),
      ...(args.status === "ingesting" && review.status !== "waiting_runtime" && review.status !== "waiting_agent" ? { attempts: review.attempts + 1 } : {}),
    });
    await ctx.db.insert("reviewRuns", {
      organizationId: review.organizationId,
      reviewId: review._id,
      stage: args.status,
      detail: args.detail ?? "",
      createdAt: Date.now(),
    });
    console.log(
      JSON.stringify({
        event: "review.stage",
        reviewId: review._id,
        repositoryId: review.repositoryId,
        prNumber: review.prNumber,
        stage: args.status,
      }),
    );
    return true;
  },
});
export const data = internalQuery({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Review not found");
    const findings = await ctx.db
      .query("findings")
      .withIndex("by_pr", (q) =>
        q
          .eq("repositoryId", review.repositoryId)
          .eq("prNumber", review.prNumber),
      )
      .collect();
    return { review, findings: findings.filter((f) => f.status === "open") };
  },
});
export const history = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: (ctx, args) =>
    ctx.db
      .query("findings")
      .withIndex("by_repo", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(100),
});
export const recordPr = internalMutation({
  args: {
    workerLease: v.optional(v.string()),
    reviewId: v.id("reviews"),
    title: v.string(),
    author: v.string(),
    url: v.string(),
    headSha: v.string(),
    baseSha: v.string(),
    state: v.string(),
    commits: v.array(v.string()),
    headBranch: v.optional(v.string()),
    baseBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Review not found");
    requireP4Worker(review,args.workerLease);
    const existing = await ctx.db
      .query("pullRequests")
      .withIndex("by_repo_number", (q) =>
        q.eq("repositoryId", review.repositoryId).eq("number", review.prNumber),
      )
      .unique();
    const data = {
      organizationId: review.organizationId,
      repositoryId: review.repositoryId,
      number: review.prNumber,
      title: args.title,
      author: args.author,
      url: args.url,
      headSha: args.headSha,
      baseSha: args.baseSha,
      state: args.state,
      updatedAt: Date.now(),
    };
    const prId = existing?._id ?? (await ctx.db.insert("pullRequests", data));
    // Native intake owns current metadata; a delayed review only owns its revision.
    if (existing?.nativeObservedAt === undefined) {
      if (existing) await ctx.db.patch(existing._id, data);
    }
    if (!existing || existing.headSha === args.headSha) {
    for (const c of await ctx.db
      .query("pullRequestCommits")
      .withIndex("by_pr", (q) => q.eq("pullRequestId", prId))
      .collect())
      await ctx.db.delete(c._id);
    for (const sha of args.commits)
      await ctx.db.insert("pullRequestCommits", {
        organizationId: review.organizationId,
        pullRequestId: prId,
        sha,
      });
    }
    await ctx.db.patch(review._id, {
      baseSha: args.baseSha,
      title: args.title,
      author: args.author,
      prUrl: args.url,
      headBranch: args.headBranch,
      baseBranch: args.baseBranch,
    });
  },
});
export const save = internalMutation({
  args: {
    workerLease: v.optional(v.string()),
    repositoryContext:v.optional(repositoryContextValidator),
    integrationScopes:v.optional(v.array(v.object({id:v.id("integrationConnections"),generation:v.number()}))),
    reviewScore: v.optional(v.object({value:v.number(),reason:v.string()})),
    verdict: v.optional(v.union(v.literal("ready"),v.literal("fixes"),v.literal("changes"),v.literal("incomplete"))),
    requirementsNotMet: v.optional(v.number()),
    aiAuthored: v.optional(v.object({ agent: v.string(), kind: v.string(), detail: v.string(), model: v.optional(v.string()) })),
    modeDecision: v.optional(v.object({ mode: v.string(), source: v.string(), capped: v.boolean(), requested: v.string() })),
    approvalAssessment: v.optional(v.object({risk:v.union(v.literal("low"),v.literal("medium"),v.literal("high"),v.literal("unknown")),confidence:v.number(),reason:v.string()})),
    coverageLimits: v.optional(v.array(v.string())),
    reviewId: v.id("reviews"),
    storageId: v.id("_storage"),
    summary: v.string(),
    findings: v.array(findingValidator),
    resolved: v.array(v.string()),
    // Resolved fingerprints whose flagged lines a commit since the last reviewed head changed (K6).
    addressed: v.optional(v.array(v.string())),
    usage: v.array(usageValidator),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review || review.status === "cancelled")
      throw new Error("Review cancelled");
    requireP4Worker(review,args.workerLease);
    if(review.nativeP4?.polling)await p4AutomaticAuthority(ctx,review.repositoryId,review.nativeP4.polling);
    if(review.nativeP4)await p4Baseline(ctx,{repositoryId:review.repositoryId,requestedBy:review.nativeP4.requestedBy,baselineJobId:review.nativeP4.baselineJobId});
    if(review.resultStorageId)throw new Error("Review result already saved; create a new review instead");
    if(args.findings.some(f=>f.commitSha!==review.headSha)||new Set(args.findings.map(f=>f.fingerprint)).size!==args.findings.length)
      throw new Error("Finding snapshots must be unique and belong to the reviewed revision");
    if(args.repositoryContext){if(args.repositoryContext.repositoryId!==review.repositoryId)throw new Error("Context receipt belongs to another review repository");await validateRepositoryContext(ctx,args.repositoryContext);}
    if(args.integrationScopes)await validateIntegrationScopes(ctx,review.repositoryId,args.integrationScopes);
    await ctx.db.patch(review._id, {
      summary: args.summary,
      repositoryContext:args.repositoryContext,
      reviewScore: args.reviewScore ? reviewScoreSchema.parse(args.reviewScore) : undefined,
      verdict: args.verdict,
      requirementsNotMet: args.requirementsNotMet,
      aiAuthored: args.aiAuthored,
      modeDecision: args.modeDecision,
      approvalAssessment: args.approvalAssessment ? approvalAssessmentSchema.parse(args.approvalAssessment) : undefined,
      coverageLimits: args.coverageLimits,
      findingCount: args.findings.length,
      findingSeverity: ["critical", "high", "medium", "low"].find((severity) =>
        args.findings.some((finding) => finding.severity === severity),
      ),
      models: [...new Set(args.usage.map((usage) => usage.model))].join(", "),
      resultStorageId: args.storageId,
      findingsRecorded:true,
      updatedAt: Date.now(),
    });
    const pr = await ctx.db
      .query("pullRequests")
      .withIndex("by_repo_number", (q) =>
        q.eq("repositoryId", review.repositoryId).eq("number", review.prNumber),
      )
      .unique();
    for (const f of args.findings) {
      const exists = await ctx.db
        .query("findings")
        .withIndex("by_fingerprint", (q) =>
          q
            .eq("repositoryId", review.repositoryId)
            .eq("prNumber", review.prNumber)
            .eq("fingerprint", f.fingerprint),
        )
        .first();
      let findingId=exists?._id;
      if (!exists)
        findingId=await ctx.db.insert("findings", {
          ...f,
          organizationId: review.organizationId,
          repositoryId: review.repositoryId,
          reviewId: review._id,
          prNumber: review.prNumber,
          author: pr?.author,
          status: "open",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      else await ctx.db.patch(exists._id,{...f,outsideDiff:f.outsideDiff,reviewId:review._id,status:"open",updatedAt:Date.now()});
      await ctx.db.insert("reviewFindings",{reviewId:review._id,findingId:findingId!,snapshot:f});
    }
    const addressed: Doc<"findings">[] = [];
    for (const fingerprint of args.resolved) {
      const f = await ctx.db
        .query("findings")
        .withIndex("by_fingerprint", (q) =>
          q
            .eq("repositoryId", review.repositoryId)
            .eq("prNumber", review.prNumber)
            .eq("fingerprint", fingerprint),
        )
        .first();
      if (f) {
        await ctx.db.patch(f._id, {
          status: "resolved",
          updatedAt: Date.now(),
        });
        if (args.addressed?.includes(fingerprint)) addressed.push(f);
      }
    }
    if (addressed.length) await recordSignals(ctx, addressed, "addressed", review.headSha);
  },
});
export const backfillFindings=internalMutation({args:{reviewId:v.id("reviews"),storageId:v.id("_storage"),findings:v.array(findingValidator)},handler:async(ctx,a)=>{
 const review=await ctx.db.get(a.reviewId);if(!review||review.resultStorageId!==a.storageId)throw new Error("Historical result changed or unavailable");
 if(review.findingsRecorded)return;
 if(a.findings.length!==review.findingCount||a.findings.some(f=>f.commitSha!==review.headSha)||new Set(a.findings.map(f=>f.fingerprint)).size!==a.findings.length)throw new Error("Historical finding coverage or revision mismatch");
 for(const snapshot of a.findings){
  const finding=await ctx.db.query("findings").withIndex("by_fingerprint",q=>q.eq("repositoryId",review.repositoryId).eq("prNumber",review.prNumber).eq("fingerprint",snapshot.fingerprint)).unique();
  if(!finding)throw new Error("Historical finding identity unavailable");
  await ctx.db.insert("reviewFindings",{reviewId:review._id,findingId:finding._id,snapshot});
 }
 await ctx.db.patch(review._id,{findingsRecorded:true});
}});
// Head of the most recent completed review of the same pull request (before this one).
export const previousHead = internalQuery({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{
  const review=await ctx.db.get(a.reviewId);
  if(!review)return null;
  const prior=(await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",review.repositoryId).eq("prNumber",review.prNumber)).order("desc").take(50))
    .find(r=>r._id!==review._id&&r.status==="completed"&&r.createdAt<review.createdAt&&r.headSha!==review.headSha&&!r.nativeP4);
  return prior?.headSha??null;
}});
// Published inline comment IDs for findings on this pull request (for thread resolution).
export const findingCommentIds = internalQuery({args:{repositoryId:v.id("repositories"),prNumber:v.number(),fingerprints:v.array(v.string())},handler:async(ctx,a)=>{
  const wanted=new Set(a.fingerprints.slice(0,100)),out:{commentId:number;fingerprint:string}[]=[];
  for(const review of await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",a.repositoryId).eq("prNumber",a.prNumber)).order("desc").take(50))
    for(const c of await ctx.db.query("reviewComments").withIndex("by_review",q=>q.eq("reviewId",review._id)).take(200))
      if(c.fingerprint&&wanted.has(c.fingerprint)&&typeof c.githubId==="number"&&!out.some(o=>o.commentId===c.githubId))out.push({commentId:c.githubId,fingerprint:c.fingerprint});
  return out;
}});
export const checkRun = internalQuery({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{const r=await ctx.db.get(a.reviewId);return r?.checkRunId?{id:r.checkRunId,head:r.checkRunHead}:null;}});
export const setCheckRun = internalMutation({args:{reviewId:v.id("reviews"),checkRunId:v.number(),checkRunHead:v.string()},handler:async(ctx,a)=>{const r=await ctx.db.get(a.reviewId);if(r)await ctx.db.patch(r._id,{checkRunId:a.checkRunId,checkRunHead:a.checkRunHead});}});
export const agentStatus = internalQuery({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{
  const review=await ctx.db.get(a.reviewId);
  return review?{status:review.status,headSha:review.headSha,agentStateStorageId:review.agentStateStorageId,agentStateHead:review.agentStateHead}:null;
}});
export const saveAgentState = internalMutation({args:{reviewId:v.id("reviews"),storageId:v.id("_storage"),headSha:v.string()},handler:async(ctx,a)=>{
  const review=await ctx.db.get(a.reviewId);
  // Returning (not throwing) keeps the orphan-blob deletion committed.
  if(!review||["cancelled","completed"].includes(review.status)||review.headSha!==a.headSha){await ctx.storage.delete(a.storageId);return false;}
  if(review.agentStateStorageId)await ctx.storage.delete(review.agentStateStorageId);
  await ctx.db.patch(review._id,{agentStateStorageId:a.storageId,agentStateHead:a.headSha,updatedAt:Date.now()});
  return true;
}});
// Hands a long agentic investigation to a fresh action step without consuming a retry attempt.
export const suspendAgent = internalMutation({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{
  const review=await ctx.db.get(a.reviewId);
  if(!review||!["ingesting","retrieving_context","reviewing"].includes(review.status)||!review.agentStateStorageId)return false;
  await ctx.db.patch(review._id,{status:"waiting_agent",updatedAt:Date.now()});
  await ctx.db.insert("reviewRuns",{organizationId:review.organizationId,reviewId:review._id,stage:"waiting_agent",detail:"Agentic investigation continues in a new step",createdAt:Date.now()});
  await ctx.scheduler.runAfter(0,internal.jobs.review,{reviewId:review._id});
  return true;
}});
// Generated-test outcomes (J3) update the stored finding and this review's snapshot of it.
export const attachGeneratedTests = internalMutation({
  args: { reviewId: v.id("reviews"), findings: v.array(v.object({ fingerprint: v.string(), confidence: v.number(), generatedTest: findingValidator.fields.generatedTest })) },
  handler: async (ctx, a) => {
    const review = await ctx.db.get(a.reviewId);
    if (!review) throw new Error("Review not found");
    for (const f of a.findings) {
      if (!f.generatedTest || f.confidence < 0 || f.confidence > 1) continue;
      const row = await ctx.db.query("findings").withIndex("by_fingerprint", (q) => q.eq("repositoryId", review.repositoryId).eq("prNumber", review.prNumber).eq("fingerprint", f.fingerprint)).first();
      if (!row || row.reviewId !== review._id) continue;
      await ctx.db.patch(row._id, { confidence: f.confidence, generatedTest: f.generatedTest, updatedAt: Date.now() });
      for (const snapshot of await ctx.db.query("reviewFindings").withIndex("by_review", (q) => q.eq("reviewId", review._id)).collect())
        if (snapshot.findingId === row._id) await ctx.db.patch(snapshot._id, { snapshot: { ...snapshot.snapshot, confidence: f.confidence, generatedTest: f.generatedTest } });
    }
  },
});
// "Review N on this pull request": assigned once, before the first publication attempt, so
// retries and resumed publications reuse it and concurrent reviews never share a number.
export const assignNumber = internalMutation({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, a) => {
    const review = await ctx.db.get(a.reviewId);
    if (!review) throw new Error("Review not found");
    if (review.reviewNumber) return review.reviewNumber;
    const siblings = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", review.repositoryId).eq("prNumber", review.prNumber)).take(5000);
    const reviewNumber = Math.max(0, ...siblings.map((r) => r.reviewNumber ?? 0)) + 1;
    await ctx.db.patch(review._id, { reviewNumber });
    return reviewNumber;
  },
});
export const finished = internalMutation({
  args: {
    reviewId: v.id("reviews"),
    githubReviewId: v.optional(v.union(v.number(),v.string())),
    comments: v.optional(
      v.array(v.object({ id: v.union(v.number(),v.string()), fingerprint: v.string() })),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review || review.status === "cancelled") return;
    if(args.error&&review.status==="completed")return;
    if(args.error&&review.retryScheduledId){
      const scheduled=await ctx.db.system.get(review.retryScheduledId);
      if(scheduled&&["pending","inProgress"].includes(scheduled.state.kind))return;
    }
    const retryAt=args.error&&review.attempts>0&&review.attempts<3?Date.now()+10000*2**review.attempts:undefined;
    const retryScheduledId=retryAt===undefined?undefined:await ctx.scheduler.runAt(retryAt,internal.jobs.review,{reviewId:review._id});
    // A scheduled retry resumes the saved agent state; a final outcome discards it.
    if(!retryScheduledId&&review.agentStateStorageId){await ctx.storage.delete(review.agentStateStorageId);await ctx.db.patch(review._id,{agentStateStorageId:undefined,agentStateHead:undefined});}
    await ctx.db.patch(review._id, {
      status: args.error ? (retryScheduledId?"queued":"failed") : "completed",
      githubReviewId: args.githubReviewId,
      error: args.error,
      updatedAt: Date.now(),
      finishedAt: retryScheduledId?undefined:Date.now(),
      retryAt,
      retryScheduledId,
    });
    if (args.githubReviewId)
      await ctx.db.insert("reviewComments", {
        organizationId: review.organizationId,
        reviewId: review._id,
        githubId: args.githubReviewId,
        createdAt: Date.now(),
      });
    for (const comment of args.comments ?? []) {
      const old = await ctx.db
        .query("reviewComments")
        .withIndex("by_review", (q) => q.eq("reviewId", review._id))
        .filter(q => q.eq(q.field("githubId"),comment.id))
        .first();
      if (!old)
        await ctx.db.insert("reviewComments", {
          organizationId: review.organizationId,
          reviewId: review._id,
          githubId: comment.id,
          fingerprint: comment.fingerprint,
          createdAt: Date.now(),
        });
    }
    if(!args.error&&!review.nativeP4)await ctx.scheduler.runAfter(0,internal.approvals.request,{reviewId:review._id});
    if(!args.error&&await notificationsEnabled(ctx,review.organizationId))await ctx.scheduler.runAfter(0,internal.notificationJobs.reviewCompleted,{reviewId:review._id});
  },
});
export const list = query({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const reader=await authorize(ctx, args.token, args.organizationId);
    const allowed = new Set((await visibleRepositories(ctx,args.token,args.organizationId)).map(r=>String(r._id)));
    const result = await ctx.db
      .query("reviews")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .paginate({ numItems: 30, cursor: args.cursor ?? null });
    const permitted=await Promise.all(result.page.map(r=>contextReadable(ctx,reader.user._id,r)));
    return {...result,page:result.page.filter((r,i)=>allowed.has(r.repositoryId)&&permitted[i])};
  },
});
export const detail = query({
  args: { token: v.string(), reviewId: v.id("reviews"), historyCursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Review not found");
    const {repo,user:viewer} = await authorizeRepository(ctx, args.token, review.repositoryId);
    await requireContextReader(ctx,viewer._id,review);
    let canWrite = false;
    try { await authorizeRepository(ctx,args.token,repo._id,true); canWrite = true; } catch { /* Read-only users can inspect history. */ }
    const config = await effectiveSettings(ctx,repo);
    const history = await ctx.db.query("reviews").withIndex("by_pr", q => q.eq("repositoryId", review.repositoryId).eq("prNumber", review.prNumber)).order("desc").paginate({numItems:10,cursor:args.historyCursor ?? null});
    const visibleHistory=await Promise.all(history.page.map(r=>contextReadable(ctx,viewer._id,r)));
    const snapshots=await ctx.db.query("reviewFindings").withIndex("by_review",q=>q.eq("reviewId",review._id)).collect();
    const latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",review.repositoryId).eq("prNumber",review.prNumber)).order("desc").first();
    const latestReadable=latest?await contextReadable(ctx,viewer._id,latest):false;
    const retry=review.retryScheduledId?await ctx.db.system.get(review.retryScheduledId):null;
    let fixReady=repo.enabled;
    if(review.nativeP4){try{await p4FixAuthority(ctx,review);fixReady=true;}catch{fixReady=false;}}
    const executionEvidence=review.runtimeEvidence?.headSha===review.headSha?review.runtimeEvidence:undefined;
    const findings=await Promise.all(snapshots.map(async s=>{
      await requireFindingReader(ctx,viewer._id,s.snapshot);
      const current=await ctx.db.get(s.findingId);
      // priority and tags are additive fields for API and MCP clients; existing fields are unchanged.
      return {...s.snapshot,priority:priorityOf(s.snapshot.severity),tags:findingTags(s.snapshot),title:executionExplanation(s.snapshot.title,executionEvidence),description:executionExplanation(s.snapshot.description,executionEvidence),impact:executionExplanation(s.snapshot.impact,executionEvidence),suggestedFix:executionExplanation(s.snapshot.suggestedFix,executionEvidence),_id:s.findingId,_creationTime:s._creationTime,organizationId:review.organizationId,repositoryId:review.repositoryId,reviewId:review._id,prNumber:review.prNumber,status:"open",currentStatus:current?.status??"unavailable",canFix:canWrite&&fixReady&&!!current&&eligibleFixFinding(current,review,latest?._id,config.minimumConfidence)};
    }));
    const nativeRows=review.nativeP4?await ctx.db.query("conversations").withIndex("by_native_review",q=>q.eq("nativeP4.reviewId",review._id)).order("desc").take(21):[];
    const nativePoll=review.nativeP4?await ctx.db.query("p4Polls").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).unique():null;
    const nativeConversations=await Promise.all(nativeRows.slice(0,20).map(async row=>{const identity=row.nativeP4?await ctx.db.get(row.nativeP4.identityId):null;return {id:row._id,author:row.author,question:row.question,answer:row.answer,error:row.error,status:row.status,attempts:row.attempts??0,updatedAt:row.updatedAt??row.createdAt,replyId:row.nativeP4?.replyId,command:row.nativeP4?.command?{kind:row.nativeP4.command.kind,requestedReviewId:row.nativeP4.command.requestedReviewId}:undefined,canRetry:canWrite&&row.status==="failed"&&identity?.userId===viewer._id&&!!identity.active&&identity.expiresAt>Date.now()&&!!nativePoll?.enabled&&latest?._id===review._id};}));
    return {
      nativeConversations,nativeConversationsTruncated:nativeRows.length>20,
      review,
      retryPending:!!retry&&["pending","inProgress"].includes(retry.state.kind),
      latestReviewId: latestReadable?latest?._id:undefined,
      history: {...history, page: history.page.filter((_,i)=>visibleHistory[i]).map(r => ({_id:r._id,headSha:r.headSha,status:r.status,createdAt:r.createdAt,findingCount:r.findingCount,reviewScore:r.reviewScore}))},
      historicalFindingsAvailable:review.findingsRecorded===true,
      canFix:findings.some(f=>f.canFix),
      runs: await ctx.db
        .query("reviewRuns")
        .withIndex("by_review", (q) => q.eq("reviewId", review._id))
        .collect(),
      findings,
      modelCalls: await ctx.db
        .query("modelCalls")
        .withIndex("by_review", (q) => q.eq("reviewId", review._id))
        .collect(),
    };
  },
});
export const cancel = mutation({
  args: { token: v.string(), reviewId: v.id("reviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Review not found");
    await authorizeRepository(ctx, args.token, review.repositoryId, true);
    if (!["completed", "failed", "cancelled"].includes(review.status))
      await cancelReview(ctx,review);
  },
});

export const recordCall = internalMutation({
  args: {
    reviewId: v.id("reviews"),
    usage: usageValidator,
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) return;
    const usage = args.usage;
    console.log(
      JSON.stringify({
        event: "review.model_call",
        reviewId: review._id,
        repositoryId: review.repositoryId,
        prNumber: review.prNumber,
        ...usage,
        error: args.error,
      }),
    );
    await ctx.db.insert("modelCalls", {
      ...usage,
      error: args.error,
      organizationId: review.organizationId,
      reviewId: review._id,
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentRuns", {
      organizationId: review.organizationId,
      reviewId: review._id,
      agent: usage.task,
      model: usage.model,
      durationMs: usage.latencyMs,
      tokens: usage.inputTokens + usage.outputTokens,
    });
    await ctx.db.insert("usageEvents", {
      organizationId: review.organizationId,
      repositoryId: review.repositoryId,
      reviewId: review._id,
      kind: "review",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCost: usage.estimatedCost,
      durationMs: usage.latencyMs,
      createdAt: Date.now(),
    });
  },
});
