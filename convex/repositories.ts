import {beginCatalog} from "./pullCatalogs";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { authorize, authorizeRepository, visibleRepositories, service } from "./auth";
import { removeFile } from "./removeFile";
import { settingsValidator,providerGroupValidator,nativeDepotIndexValidator } from "./schema";
import {indexWriteAllowed,indexBatchMatches} from "./indexAuthority";
import {adoptP4Baseline} from "./p4Polling";
import {p4SubmittedRevision} from "../src/p4-revision";

import { defaults,validSummarySections,validReviewEngine,validCheckFailureSeverity,validTriggerSettings } from "../src/review-settings";
import { categories } from "../src/engine/types";
export { defaults } from "../src/review-settings";
import { effectiveSettings,providerTeam } from "./scopes";
import type {QueryCtx,MutationCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";
export async function indexingAccess(ctx:QueryCtx|MutationCtx,repo:Doc<"repositories">){
 if(repo.connectionId){const c=await ctx.db.get(repo.connectionId);if(!c||c.organizationId!==repo.organizationId||!c.active||c.suspended)return "Provider access is disconnected or suspended";if(c.kind==="perforce")return "Perforce automatic reviews require the native polling controls; use CLI index/upload or the opt-in watch worker for submitted indexing";}
 else {const installationId=repo.installationId;if(installationId===undefined)return "GitHub installation access is unavailable";const installation=await ctx.db.query("githubInstallations").withIndex("by_installation",q=>q.eq("installationId",installationId)).unique();if(!installation?.active||installation.organizationId!==repo.organizationId)return "GitHub installation access is unavailable";}
 return null;
}
export async function enableIndexing(ctx:MutationCtx,repo:Doc<"repositories">){
 const error=await indexingAccess(ctx,repo);if(error)throw new Error(error);
 const scheduled=repo.indexScheduledId?await ctx.db.system.get(repo.indexScheduledId):null;
 const queued=repo.indexStatus==="queued"&&scheduled&&["pending","inProgress"].includes(scheduled.state.kind);
 const pending=(!repo.indexedSha||["failed","cancelled"].includes(repo.indexStatus))&&!queued&&repo.indexStatus!=="indexing";
 await ctx.db.patch(repo._id,{enabled:true,...(pending?{indexStatus:"queued",error:undefined}:{})});
 const catalog=await ctx.db.query("pullCatalogJobs").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).order("desc").first();
 if(!repo.enabled||!catalog)await beginCatalog(ctx,repo._id);
 if(pending){const indexScheduledId=await ctx.scheduler.runAfter(0,internal.jobs.index,{repositoryId:repo._id});await ctx.db.patch(repo._id,{indexScheduledId});}
}
export async function cancelRepositoryIndex(ctx:MutationCtx,repo:Doc<"repositories">){
 const scheduled=repo.indexScheduledId?await ctx.db.system.get(repo.indexScheduledId):null;
 if(scheduled?.state.kind==="pending")await ctx.scheduler.cancel(scheduled._id);
 for(const job of await ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).collect())if(job.status==="running")await ctx.db.patch(job._id,{status:"cancelled",updatedAt:Date.now()});
 if(["queued","indexing"].includes(repo.indexStatus))await ctx.db.patch(repo._id,{indexStatus:"cancelled",pendingIndexSha:undefined,error:undefined});
}
export async function disableRepository(ctx:MutationCtx,repo:Doc<"repositories">){await ctx.db.patch(repo._id,{enabled:false});await cancelRepositoryIndex(ctx,repo);}
export const indexPreparationFailed=internalMutation({args:{repositoryId:v.id("repositories"),jobId:v.optional(v.id("indexJobs")),error:v.string()},handler:async(ctx,a)=>{
 const repo=await ctx.db.get(a.repositoryId);if(!repo?.enabled)return;
 const job=await ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).order("desc").first();
 if(a.jobId){if(!job||job._id!==a.jobId||job.status!=="running")return;await ctx.db.patch(job._id,{status:"failed",error:a.error.slice(0,1000),updatedAt:Date.now()});}
 else if(job?.status==="running"&&job.updatedAt>Date.now()-15*60000)return;
 await ctx.db.patch(repo._id,{indexStatus:"failed",error:a.error.slice(0,1000)});
}});
export const list = query({
  args: { token: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    await authorize(ctx, args.token, args.organizationId);
    return visibleRepositories(ctx, args.token, args.organizationId);
  },
});
export const configure = mutation({
  args: {
    token: v.string(),
    repositoryId: v.id("repositories"),
    enabled: v.boolean(),
    settings: v.optional(settingsValidator),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    await authorizeRepository(ctx, args.token, repo._id, true, Boolean("settings" in args && args.settings));
    if (args.settings) {
      const s = args.settings;
      if (
        s.maxComments < 0 ||
        s.maxComments > 30 ||
        !Number.isInteger(s.maxComments) ||
        !Number.isFinite(s.minimumConfidence) ||
        s.minimumConfidence < 0.5 ||
        s.minimumConfidence > 1 ||
        !["critical", "high", "medium", "low"].includes(s.severityThreshold) ||
        !["fast", "standard", "deep"].includes(s.mode) ||
        !["concise", "detailed"].includes(s.commentStyle) ||
        !validSummarySections(s.summarySections) ||
        !validReviewEngine(s.reviewEngine) ||
        !validCheckFailureSeverity(s.checkFailureSeverity) ||
        !validTriggerSettings(s) ||
        s.categories.some((c) => !(categories as readonly string[]).includes(c))
      )
        throw new Error("Invalid review settings");
      const existing = await ctx.db
        .query("repositorySettings")
        .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { settings: s, inherit: false });
      else
        await ctx.db.insert("repositorySettings", {
          repositoryId: repo._id,
          organizationId: repo.organizationId,
          settings: s,
        });
    }
    if(args.enabled)await enableIndexing(ctx,repo);else await disableRepository(ctx,repo);
  },
});
export const reindex = mutation({
  args: { token: v.string(), repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    await authorizeRepository(ctx, args.token, repo._id, true, Boolean("settings" in args && args.settings));
    const error=await indexingAccess(ctx,repo);if(error)throw new Error(error);
    if(!repo.enabled)throw new Error("Enable the repository before indexing");
    const scheduled=repo.indexScheduledId?await ctx.db.system.get(repo.indexScheduledId):null;
    if(repo.indexStatus==="indexing"||repo.indexStatus==="queued"&&scheduled&&["pending","inProgress"].includes(scheduled.state.kind))return;
    const indexScheduledId=await ctx.scheduler.runAfter(0, internal.jobs.index, {
      repositoryId: repo._id,
    });
    // The server action refreshes before the worker finishes preparation. Expose
    // queued state immediately so the portal keeps polling through recovery.
    await ctx.db.patch(repo._id,{indexStatus:"queued",error:undefined,indexScheduledId});
  },
});
export const connect = mutation({
  args: {
    token: v.string(),
    secret: v.string(),
    organizationId: v.id("organizations"),
    installationId: v.number(),
    account: v.string(),
    accountId: v.number(),
    repositories: v.array(
      v.object({
        id: v.number(),
        fullName: v.string(),
        defaultBranch: v.string(),
        group: v.optional(providerGroupValidator),
      }),
    ),
  },
  handler: async (ctx, args) => {
    service(args.secret);
    const {user}=await authorize(ctx, args.token, args.organizationId, true);
    const existing = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation", (q) =>
        q.eq("installationId", args.installationId),
      )
      .unique();
    if (existing && existing.organizationId !== args.organizationId)
      throw new Error("Installation belongs to another workspace");
    if (!existing)
      await ctx.db.insert("githubInstallations", {
        organizationId: args.organizationId,
        installationId: args.installationId,
        account: args.account,
        accountId: args.accountId,
        active: true,
        createdAt: Date.now(),
      });
    for (const repository of args.repositories) {
      const teamId=repository.group?await providerTeam(ctx,args.organizationId,"github","https://api.github.com",repository.group,user._id):undefined;
      const repo = await ctx.db
        .query("repositories")
        .withIndex("by_github", (q) => q.eq("githubId", repository.id))
        .unique();
      if (repo && repo.organizationId !== args.organizationId)
        throw new Error("Repository already connected to another workspace");
      if (!repo) {
        const repositoryId = await ctx.db.insert("repositories", {
          organizationId: args.organizationId,
          installationId: args.installationId,
          teamId,
          githubId: repository.id,
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          enabled: false,
          indexStatus: "not_indexed",
          createdAt: Date.now(),
        });
        await ctx.db.insert("repositorySettings", {
          repositoryId,
          organizationId: args.organizationId,
          inherit: true,
          settings: defaults,
        });
      }
    }
  },
});
// Bounded configuration for a review/index step. File inventories are read on demand through
// filesByPath / filePage / filesUnder so large repositories never exceed transaction read limits.
export const data = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    const rules = (
      await ctx.db
        .query("customRules")
        .withIndex("by_org", (q) => q.eq("organizationId", repo.organizationId))
        .take(maxRules)
    ).filter(
      (r) => r.enabled && (!r.repositoryId || r.repositoryId === repo._id),
    );
    const own = await ctx.db
      .query("learnedPreferences")
      .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
      .order("desc")
      .take(maxPreferences);
    // Workspace- and team-scoped preferences learned in other repositories apply here too.
    const shared = [
      ...(await ctx.db.query("learnedPreferences").withIndex("by_org_scope", (q) => q.eq("organizationId", repo.organizationId).eq("scope", "workspace")).take(500)),
      ...(repo.teamId ? (await ctx.db.query("learnedPreferences").withIndex("by_org_scope", (q) => q.eq("organizationId", repo.organizationId).eq("scope", "team")).take(500)).filter((p) => p.teamId === repo.teamId) : []),
    ].filter((p) => p.repositoryId !== repo._id);
    const preferences = [...own, ...shared];
    return {
      repo,
      settings: await effectiveSettings(ctx, repo),
      rules,
      preferences: preferences.filter((p) => p.enabled),
    };
  },
});
export const recordConfigFile = internalMutation({args:{repositoryId:v.id("repositories"),sha:v.string(),files:v.array(v.string()),applied:v.array(v.string()),blocked:v.array(v.string()),warnings:v.array(v.string()),values:v.string(),rules:v.number()},handler:async(ctx,a)=>{
  const repo=await ctx.db.get(a.repositoryId);if(!repo)return;
  await ctx.db.patch(repo._id,{configFile:a.files.length||a.warnings.length?{sha:a.sha,files:a.files.slice(0,60),applied:a.applied,blocked:a.blocked,warnings:a.warnings.slice(0,20).map(w=>w.slice(0,500)),values:a.values.slice(0,4000),rules:a.rules,checkedAt:Date.now()}:undefined});
}});
export const maxRules = 1000, maxPreferences = 1000, fileLookupBatch = 200, filePageSize = 1000;
const fileRow = (f: Doc<"repositoryFiles">) => ({ path: f.path, sha: f.sha, storageId: f.storageId, graphVersion: f.graphVersion });
export const filesByPath = internalQuery({args:{repositoryId:v.id("repositories"),paths:v.array(v.string())},handler:async(ctx,a)=>{
  if(a.paths.length>fileLookupBatch)throw new Error(`File lookup batch exceeds ${fileLookupBatch} paths`);
  const rows=await Promise.all([...new Set(a.paths)].map(path=>ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",a.repositoryId).eq("path",path)).unique()));
  return rows.filter((r):r is Doc<"repositoryFiles">=>r!==null).map(fileRow);
}});
export const filePage = internalQuery({args:{repositoryId:v.id("repositories"),cursor:v.union(v.string(),v.null()),numItems:v.optional(v.number())},handler:async(ctx,a)=>{
  const numItems=Math.min(Math.max(1,Math.floor(a.numItems??filePageSize)),filePageSize);
  const page=await ctx.db.query("repositoryFiles").withIndex("by_repo",q=>q.eq("repositoryId",a.repositoryId)).paginate({cursor:a.cursor,numItems});
  return {files:page.page.map(f=>({path:f.path,sha:f.sha})),cursor:page.continueCursor,done:page.isDone};
}});
// Files under directory prefixes plus exact well-known paths, via path-index ranges.
export const filesUnder = internalQuery({args:{repositoryId:v.id("repositories"),directories:v.array(v.string()),paths:v.array(v.string()),limit:v.number()},handler:async(ctx,a)=>{
  if(a.directories.length+a.paths.length>100)throw new Error("Directory lookup exceeds 100 prefixes");
  const limit=Math.min(Math.max(1,Math.floor(a.limit)),200),out=new Map<string,ReturnType<typeof fileRow>>();
  for(const path of a.paths){const row=await ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",a.repositoryId).eq("path",path)).unique();if(row)out.set(row.path,fileRow(row));}
  for(const directory of [...new Set(a.directories)]){
    if(out.size>=limit)break;
    const prefix=directory?directory.replace(/\/$/,"")+"/":"";
    const rows=await ctx.db.query("repositoryFiles").withIndex("by_path",q=>prefix?q.eq("repositoryId",a.repositoryId).gte("path",prefix).lt("path",prefix+"\uffff"):q.eq("repositoryId",a.repositoryId)).take(limit);
    for(const row of rows)if(out.size<limit&&(prefix||!row.path.includes("/")))out.set(row.path,fileRow(row));
  }
  return [...out.values()].slice(0,limit);
}});
export const indexModuleReferences=internalQuery({args:{repositoryId:v.id("repositories"),paths:v.array(v.string())},handler:async(ctx,a)=>{
  if(a.paths.length>20)throw new Error("Module receipt batch exceeds 20 files");
  return Promise.all(a.paths.map(path=>ctx.db.query("graphModuleReferences").withIndex("by_path",q=>q.eq("repositoryId",a.repositoryId).eq("path",path)).unique()));
}});
export const indexing = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    sha: v.string(),
    total: v.number(),
    nativeDepot:v.optional(nativeDepotIndexValidator),
    branches: v.optional(
      v.array(
        v.object({ name: v.string(), sha: v.string(), protected: v.boolean() }),
      ),
    ),
    branchesLimited: v.optional(v.boolean()),
    knowledgePaths: v.optional(v.array(v.string())),
    skipped: v.optional(v.array(v.object({path:v.string(),reason:v.string()}))),
    skippedTotal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return null;
    if(args.nativeDepot){
      if(!await indexWriteAllowed(ctx,repo,{repositoryId:repo._id,organizationId:repo.organizationId,status:"running",nativeDepot:args.nativeDepot}))throw new Error("Native indexing access revoked");
      const next=p4SubmittedRevision(args.sha);
      if(repo.indexedSha){const previous=p4SubmittedRevision(repo.indexedSha);if(previous.serverId!==next.serverId||next.change<previous.change)throw new Error("P4 submitted baseline cannot change server identity or move backwards");}
    }else if(!repo.enabled)return null;
    const current = await ctx.db
      .query("indexJobs")
      .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
      .order("desc")
      .first();
    if (
      current?.status === "running" &&
      current.updatedAt > Date.now() - 15 * 60000
    ) {
      if(args.nativeDepot)throw new Error("An index job is already running; retry after it completes");
      if (current.sha !== args.sha)
        await ctx.db.patch(repo._id, { pendingIndexSha: args.sha });
      return null;
    }
    if(current?.status==="running")await ctx.db.patch(current._id,{status:"cancelled",error:"Superseded by a new indexing attempt",updatedAt:Date.now()});
    await ctx.db.patch(repo._id, {
      indexStatus: "indexing",
      ...(args.knowledgePaths?.length
        ? {
            knowledgeStatus: "queued",
            knowledgePaths: args.knowledgePaths,
            knowledgeAttempt: 1,
            knowledgeUpdatedAt: Date.now(),
            knowledgeError: undefined,
          }
        : {}),
      error: undefined,
      ...(args.branches
        ? { branches: args.branches, branchesLimited: args.branchesLimited }
        : {}),
    });
    return ctx.db.insert("indexJobs", {
      organizationId: repo.organizationId,
      repositoryId: repo._id,
      sha: args.sha,
      nativeDepot:args.nativeDepot,
      total: args.total,
      skipped: args.skipped,
      skippedTotal: args.skippedTotal,
      processed: 0,
      changed: 0,
      attempts: 1,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});
export const indexJob = internalQuery({
  args: { jobId: v.id("indexJobs") },
  handler: (ctx, args) => ctx.db.get(args.jobId),
});
export const indexAllowed=internalQuery({args:{jobId:v.id("indexJobs")},handler:async(ctx,a)=>{const job=await ctx.db.get(a.jobId);return indexWriteAllowed(ctx,job?await ctx.db.get(job.repositoryId):null,job);}});
export const claimIndexBatch=internalMutation({args:{jobId:v.id("indexJobs"),leaseId:v.string()},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.jobId);if(!job||job.status!=="running"||job.batchLease&&job.batchLease.expiresAt>Date.now())return null;
 const repo=await ctx.db.get(job.repositoryId);if(!await indexWriteAllowed(ctx,repo,job)){await ctx.db.patch(job._id,{status:"cancelled",error:"Indexing authorization was revoked",updatedAt:Date.now()});if(repo&&repo.indexStatus==="indexing")await ctx.db.patch(repo._id,{indexStatus:"cancelled",error:"Indexing authorization was revoked"});return null;}
 const batchLease={id:a.leaseId,expiresAt:Date.now()+15*60000};await ctx.db.patch(job._id,{batchLease,updatedAt:Date.now()});return {...job,batchLease};
}});
export const indexProgress = internalMutation({
  args: {
    jobId: v.id("indexJobs"),
    cursor: v.number(),
    manifestStorageId: v.optional(v.id("_storage")),
    leaseId:v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") return;
    if(!indexBatchMatches(job,args.leaseId))return;
    const repo = await ctx.db.get(job.repositoryId);
    if (!await indexWriteAllowed(ctx,repo,job)) {
      await ctx.db.patch(job._id, {
        status: "cancelled",
        updatedAt: Date.now(),
      });
      if(repo&&["queued","indexing"].includes(repo.indexStatus))await ctx.db.patch(repo._id,{indexStatus:"cancelled",error:undefined});
      return;
    }
    await ctx.db.patch(job._id, {
      cursor: args.cursor,
      processed: args.cursor,
      ...(args.manifestStorageId
        ? { manifestStorageId: args.manifestStorageId }
        : {}),
      updatedAt: Date.now(),
      batchLease:undefined,
    });
    await ctx.scheduler.runAfter(0, internal.jobs.indexBatch, {
      jobId: job._id,
    });
  },
});
export const indexedFile = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    jobId: v.id("indexJobs"),
    path: v.string(),
    leaseId:v.optional(v.string()),
    sha: v.string(),
    graphVersion: v.optional(v.number()),
    graphModuleReferences: v.optional(v.array(v.object({specifier:v.string(),resolvedPath:v.string()}))),
    storageId: v.id("_storage"),
    chunks: v.array(v.object({ content: v.string(), startLine: v.number() })),
    symbols: v.array(
      v.object({
        name: v.string(),
        kind: v.string(),
        line: v.number(),
        exported: v.boolean(),
      }),
    ),
    relationships: v.array(
      v.object({ from: v.string(), to: v.string(), kind: v.string(), symbol: v.optional(v.string()), resolved: v.optional(v.boolean()) }),
    ),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId),
      job = await ctx.db.get(args.jobId);
    if (!repo || !job || !indexBatchMatches(job,args.leaseId)|| !await indexWriteAllowed(ctx,repo,job)) {await ctx.storage.delete(args.storageId);return;}
    const old = await ctx.db
      .query("repositoryFiles")
      .withIndex("by_path", (q) =>
        q.eq("repositoryId", repo._id).eq("path", args.path),
      )
      .unique();
    const record = {
      organizationId: repo.organizationId,
      repositoryId: repo._id,
      path: args.path,
      sha: args.sha,
      storageId: args.storageId,
      language: args.path.split(".").pop() ?? "",
      graphVersion: args.graphVersion,
      updatedAt: Date.now(),
    };
    if (old) {
      await ctx.db.patch(old._id, record);
      await ctx.storage.delete(old.storageId);
    } else await ctx.db.insert("repositoryFiles", record);
    const receipt=await ctx.db.query("graphModuleReferences").withIndex("by_path",q=>q.eq("repositoryId",repo._id).eq("path",args.path)).unique();
    if(args.graphVersion!==undefined&&args.graphModuleReferences!==undefined){
      const value={repositoryId:repo._id,path:args.path,sha:args.sha,graphVersion:args.graphVersion,references:args.graphModuleReferences};
      if(receipt)await ctx.db.patch(receipt._id,value);else await ctx.db.insert("graphModuleReferences",value);
    }else if(receipt)await ctx.db.delete(receipt._id);
    const symbols = await ctx.db
      .query("symbols")
      .withIndex("by_file", (q) =>
        q.eq("repositoryId", repo._id).eq("filePath", args.path),
      )
      .collect();
    for (const s of symbols) await ctx.db.delete(s._id);
    const edges = await ctx.db
      .query("relationships")
      .withIndex("by_source", (q) =>
        q.eq("repositoryId", repo._id).eq("sourcePath", args.path),
      )
      .collect();
    for (const e of edges) await ctx.db.delete(e._id);
    for (const chunk of await ctx.db
      .query("codeChunks")
      .withIndex("by_file", (q) =>
        q.eq("repositoryId", repo._id).eq("filePath", args.path),
      )
      .collect())
      await ctx.db.delete(chunk._id);
    for (const chunk of args.chunks)
      await ctx.db.insert("codeChunks", {
        organizationId: repo.organizationId,
        repositoryId: repo._id,
        filePath: args.path,
        ...chunk,
      });
    for (const s of args.symbols.slice(0, 500))
      await ctx.db.insert("symbols", {
        organizationId: repo.organizationId,
        repositoryId: repo._id,
        filePath: args.path,
        ...s,
      });
    for (const r of args.relationships.slice(0, 1000))
      await ctx.db.insert("relationships", {
        organizationId: repo.organizationId,
        repositoryId: repo._id,
        sourcePath: args.path,
        ...r,
      });
    await ctx.db.patch(job._id, {
      processed: job.processed + 1,
      changed: job.changed + (old?.sha === args.sha ? 0 : 1),
      updatedAt: Date.now(),
    });
  },
});
export const finishIndex = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    jobId: v.id("indexJobs"),
    sha: v.string(),
    // Stale stored files are swept by the caller before completion (removeIndexedFiles);
    // completion only reads the bounded knowledge set, never the whole file inventory.
    processed: v.optional(v.number()),
    knowledgePaths:v.optional(v.array(v.string())),
    removedPaths:v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    leaseId:v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    const job = await ctx.db.get(args.jobId);
    if(!repo)return false;
    if(!job||job.repositoryId!==repo._id||job.status!=="running"||job.sha!==args.sha)return false;
    if(!indexBatchMatches(job,args.leaseId))return false;
    if(!await indexWriteAllowed(ctx,repo,job)){await ctx.db.patch(job._id,{status:"cancelled",error:"Indexing authorization was revoked",updatedAt:Date.now()});if(["queued","indexing"].includes(repo.indexStatus))await ctx.db.patch(repo._id,{indexStatus:"cancelled",error:"Indexing authorization was revoked"});return false;}
    if (args.error && job && job.attempts < 3) {
      await ctx.db.patch(job._id, {
        status: "running",
        attempts: job.attempts + 1,
        batchLease:undefined,
        error: args.error,
        updatedAt: Date.now(),
      });
      await ctx.db.patch(repo._id, {
        indexStatus: "indexing",
        error: `Retrying indexing: ${args.error}`,
      });
      await ctx.scheduler.runAfter(
        10000 * job.attempts,
        internal.jobs.indexBatch,
        { jobId: job._id },
      );
      return;
    }
    if (!args.error) {
      const stored=new Map<string,boolean>();
      const isStored=async(path:string)=>{
        if(!stored.has(path))stored.set(path,!!await ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",repo._id).eq("path",path)).unique());
        return stored.get(path)!;
      };
      // Only retained sources may remain in generated knowledge.
      const removedKnowledgePaths=new Set<string>();
      for (const entry of await ctx.db
        .query("knowledgeEntries")
        .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
        .take(500)) {
        const remaining:string[]=[];
        for(const path of entry.files.slice(0,100))if(stored.size<3000&&!await isStored(path))removedKnowledgePaths.add(path);else remaining.push(path);
        if (entry.files.length && !remaining.length)
          await ctx.db.delete(entry._id);
        else if (remaining.length !== entry.files.length)
          await ctx.db.patch(entry._id, {
            files: remaining,
            sha: args.sha,
            updatedAt: Date.now(),
          });
      }
      await ctx.db.patch(repo._id, {
        indexStatus: "ready",
        indexedSha: args.sha,
        indexedAt: Date.now(),
        error: undefined,
        pendingIndexSha: undefined,
      });
      if(args.knowledgePaths){
        const removed=new Set(args.removedPaths??[]),knowledgePaths:string[]=[];
        for(const path of [...new Set(args.knowledgePaths)].slice(0,500))if(removed.has(path)||removedKnowledgePaths.has(path)||await isStored(path))knowledgePaths.push(path);
        await ctx.db.patch(repo._id,{knowledgePaths,knowledgeStatus:knowledgePaths.length?"queued":"completed",knowledgeError:undefined,knowledgeUpdatedAt:Date.now()});
        if(knowledgePaths.length)await ctx.scheduler.runAfter(0,internal.knowledgeJobs.generate,{repositoryId:repo._id,paths:knowledgePaths});
      }
      if (!job.nativeDepot && repo.pendingIndexSha && repo.pendingIndexSha !== args.sha)
        await ctx.scheduler.runAfter(0, internal.jobs.index, {
          repositoryId: repo._id,
        });
    } else
      await ctx.db.patch(repo._id, {
        indexStatus: "failed",
        ...(repo.knowledgeStatus === "queued"
          ? { knowledgeStatus: "waiting_for_index" }
          : {}),
        error: args.error,
      });
    await ctx.db.patch(args.jobId, {
      status: args.error ? "failed" : "completed",
      batchLease:undefined,
      error: args.error,
      ...(!args.error && args.processed !== undefined ? { processed: args.processed } : {}),
      updatedAt: Date.now(),
    });
    if(!args.error&&job.nativeDepot)await adoptP4Baseline(ctx,{...job,status:"completed"});
    return !args.error;
  },
});

export const removeIndexedFiles = internalMutation({
  args: { repositoryId: v.id("repositories"),jobId:v.id("indexJobs"), paths: v.array(v.string()),leaseId:v.optional(v.string()) },
  handler: async(ctx, args) => {
    if(args.paths.length>25)throw new Error("Removal batch exceeds 25 files");
    const job=await ctx.db.get(args.jobId),repo=await ctx.db.get(args.repositoryId);
    if(!job||job.repositoryId!==args.repositoryId||!indexBatchMatches(job,args.leaseId)||!await indexWriteAllowed(ctx,repo,job))return false;
    for(const path of args.paths)await removeFile(ctx, args.repositoryId, path);
    return true;
  },
});
export const removeIndexedFile = internalMutation({
  args: { repositoryId: v.id("repositories"),jobId:v.id("indexJobs"), path: v.string(),leaseId:v.optional(v.string()) },
  handler: async(ctx, args) => {const job=await ctx.db.get(args.jobId),repo=await ctx.db.get(args.repositoryId);if(job&&indexBatchMatches(job,args.leaseId)&&await indexWriteAllowed(ctx,repo,job))await removeFile(ctx, args.repositoryId, args.path);},
});

export const skippedFile = internalMutation({args:{jobId:v.id("indexJobs"),path:v.string(),reason:v.string(),leaseId:v.optional(v.string())},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.jobId); if(!job || job.status!=="running")return;
 if(!indexBatchMatches(job,a.leaseId)||!await indexWriteAllowed(ctx,await ctx.db.get(job.repositoryId),job))return;
 if(job.skipped?.some(f=>f.path===a.path))return;
 // The visible exclusion sample is capped, so it cannot also be the retry
 // deduplication ledger. Keep per-job receipts for content-time exclusions.
 if(await ctx.db.query("indexSkippedFiles").withIndex("by_job_path",q=>q.eq("jobId",job._id).eq("path",a.path)).unique())return;
 await ctx.db.insert("indexSkippedFiles",{jobId:job._id,path:a.path});
 await ctx.db.patch(job._id,{skipped:[...(job.skipped??[]),{path:a.path,reason:a.reason}].slice(0,500),skippedTotal:(job.skippedTotal??0)+1});
}});
