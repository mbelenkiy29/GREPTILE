"use node";
import {budgetModel,inferenceBilling} from "./budgetModel";
import {executionExplanation} from "../src/execution-claims";
import { action,internalAction,type ActionCtx } from "./_generated/server";
import { api,internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {hasCurrentRepositoryEvidence} from "../src/context-history";
import type {RepositoryContext} from "./repositoryContext";
import { z } from "zod";
import { provider } from "./scm";
import { fileInventory, indexedFiles } from "./fileReads";
import { reviewAgentHooks, reviewToolbox } from "./agentToolbox";
import { semanticHits } from "./semanticSearch";
import { Github } from "../src/github";
import { Gitlab } from "../src/gitlab";
import type { Scm } from "../src/gitlab";
import { hybridRank } from "../src/engine/hybrid";
import { validSequence } from "../src/diagrams";
import { incrementalDiff } from "../src/incremental";
import { checkConclusion, type CheckConclusion } from "../src/github";
import { AgentSuspended } from "../src/engine/agent";
import {parseP4SubmittedInventory} from "../src/p4-index";
import {P4CodeReview,p4Credential} from "../src/perforce";
import {decryptCredential} from "../src/credentials";
import { eligibleFile, exclusionReason, indexRepository, moduleReferencesCurrent, redact } from "../src/engine/indexer";
import {INDEX_GRAPH_VERSION} from "../src/engine/index-version";
import { loadGrammars } from "../src/engine/treesitter";
// Validate shared summaries against recorded test evidence before native publication.
import { reviewChange } from "../src/engine/review";
import { semanticChunks, sourceChunks } from "../src/engine/chunks";
import { Embeddings } from "../src/engine/embeddings";
import { ModelFailure, configuredModel } from "../src/engine/model";
import {
  categories,
  findingSchema,
  severities,
  type SourceFile,
  type ModelProvider,
} from "../src/engine/types";

export const backfillReviewFindings=internalAction({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{
 const {review}=await ctx.runQuery(internal.reviews.data,a);
 if(review.findingsRecorded)return {status:"already_recorded"};
 if(!review.resultStorageId)return {status:"no_saved_result"};
 const blob=await ctx.storage.get(review.resultStorageId);if(!blob||blob.size>2000000)throw new Error("Historical result unavailable or exceeds recovery limit");
 const finding=findingSchema.and(z.object({agent:z.string(),fingerprint:z.string(),commitSha:z.string()}));
 const result=z.object({findings:z.array(finding),metadata:z.object({carriedForward:z.array(finding).optional()}).optional()}).parse(JSON.parse(await blob.text()));
 const findings=[...result.findings,...(result.metadata?.carriedForward??[])];
 await ctx.runMutation(internal.reviews.backfillFindings,{reviewId:review._id,storageId:review.resultStorageId,findings});
 return {status:"recovered",count:findings.length};
}});

export const index = internalAction({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const { repo } = await ctx.runQuery(
      internal.repositories.data,
      args,
    );
    if (!repo.enabled) return;
    const known = await fileInventory(ctx, repo._id);
    let jobId:Id<"indexJobs">|null=null;
    try {
    const github = await provider(ctx,repo);
    const branch = {sha:await github.head(repo.fullName,repo.defaultBranch)};
    const tree = await github.tree(repo.fullName, branch.sha);
    const branches = await github.branches(repo.fullName);
    const ignoreEntry = tree.find((f) => f.path === ".gitignore");
    const gitignore = ignoreEntry
      ? (await github.blob(repo.fullName, ignoreEntry.path, ignoreEntry.sha))
          .content
      : "";
    const entries = tree.filter((f) =>
      eligibleFile({ path: f.path, sha: f.sha, size:f.size, content: "" }, gitignore),
    );
    const indexedPaths = new Set(entries.map((entry) => entry.path));
    const changedPaths = [
      ...entries.filter((f) => known.get(f.path) !== f.sha).map((f) => f.path),
      ...[...known.keys()].filter((path) => !indexedPaths.has(path)),
    ];
    jobId = await ctx.runMutation(internal.repositories.indexing, {
      repositoryId: repo._id,
      sha: branch.sha,
      total: entries.length,
      skipped: tree.filter(f=>!indexedPaths.has(f.path)).slice(0,500).map(f=>({path:f.path,reason:exclusionReason({path:f.path,sha:f.sha,size:f.size,content:""},gitignore)!})),
      skippedTotal: tree.length-entries.length,
      branches: branches.branches,
      branchesLimited: branches.limited,
      knowledgePaths: changedPaths.slice(0, 500),
    });
    if (!jobId) return;
    const manifestStorageId = await ctx.storage.store(
      new Blob(
        [JSON.stringify({ sha: branch.sha, gitignore, entries, changedPaths })],
        { type: "application/json" },
      ),
    );
    await ctx.runMutation(internal.repositories.indexProgress, {
      jobId,
      cursor: 0,
      manifestStorageId,
    });
    }catch(error){
      await ctx.runMutation(internal.repositories.indexPreparationFailed,{repositoryId:repo._id,...(jobId?{jobId}:{}),error:error instanceof Error?error.message:"Index preparation failed"});
      throw error;
    }
  },
});

export const indexBatch = internalAction({
  args: { jobId: v.id("indexJobs") },
  handler: async (ctx, args) => {
    const leaseId=crypto.randomUUID();
    const job = await ctx.runMutation(internal.repositories.claimIndexBatch, {...args,leaseId});
    if (!job || job.status !== "running") return;
    try {
    const data = await ctx.runQuery(internal.repositories.data, {
      repositoryId: job.repositoryId,
    });
    if(!await ctx.runQuery(internal.repositories.indexAllowed,{jobId:job._id})){await ctx.runMutation(internal.repositories.indexProgress,{jobId:job._id,cursor:job.cursor??0,leaseId});return;}
    if(!job.manifestStorageId)throw new Error("Index manifest unavailable");
    const blob = await ctx.storage.get(job.manifestStorageId);
    if (!blob) throw new Error("Index manifest unavailable");
    const manifest = z
      .object({
        sha: z.string(),
        gitignore: z.string(),
        changedPaths: z.array(z.string()).optional(),
        entries: z.array(z.object({ path: z.string(), sha: z.string() })),
        inventory:z.unknown().optional(),
      })
      .parse(JSON.parse(await blob.text()));
    if(manifest.sha!==job.sha)throw new Error("Index manifest revision does not match its job");
    const cursor = job.cursor ?? 0;
      const inventory=job.nativeDepot?parseP4SubmittedInventory(manifest.inventory):null;
      let p4:P4CodeReview|undefined;
      if(inventory){
        if(inventory.revision!==job.sha||inventory.project.id!==data.repo.externalId)throw new Error("P4 index inventory identity mismatch");
        const c=await ctx.runQuery(internal.providerConnections.data,{id:job.nativeDepot!.connectionId});
        const credential=p4Credential.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+":perforce")));
        p4=new P4CodeReview(c.instance,credential.username,credential.ticket);
        if(JSON.stringify(await p4.project(inventory.project.id))!==JSON.stringify(inventory.project))throw new Error("P4 project views changed during hosted indexing");
      }
      const github = inventory?undefined:await provider(ctx,data.repo);
      const allPaths = manifest.entries.map((f) => f.path);
      const pathSet=new Set(allPaths);
      const batch=manifest.entries.slice(cursor,cursor+20);
      const known = new Map((await indexedFiles(ctx, data.repo._id, batch.map((f) => f.path))).map((f) => [f.path, f]));
      const receipts=await ctx.runQuery(internal.repositories.indexModuleReferences,{repositoryId:data.repo._id,paths:batch.map(f=>f.path)});
      const references=new Map(receipts.filter(r=>r!==null).map(r=>[r.path,r]));
      for (const entry of batch) {
        const previous=known.get(entry.path);
        const receipt=references.get(entry.path);
        if (previous?.sha === entry.sha && previous.graphVersion === INDEX_GRAPH_VERSION && receipt?.sha===entry.sha && receipt.graphVersion===INDEX_GRAPH_VERSION && moduleReferencesCurrent(entry.path,receipt.references,pathSet)) {
          if (!process.env.EMBEDDING_MODEL) continue;
          const embedded = await ctx.runQuery(internal.embeddings.chunkState, { repositoryId: data.repo._id, path: entry.path });
          if (embedded?.sha === entry.sha && embedded.model === process.env.EMBEDDING_MODEL) continue;
        }
        const expected=inventory?.manifest.find(f=>f.depotFile.slice(2)===entry.path);
        if(inventory&&!expected)throw new Error("P4 index entry outside pinned inventory");
        const file = inventory?await p4!.submittedContent(inventory.project,expected!,inventory.serverId,inventory.change):await github!.blob(data.repo.fullName,entry.path,entry.sha);
        if(file.sha!==entry.sha)throw new Error("Index source identity mismatch");
        if (!eligibleFile(file, manifest.gitignore)) {
          await ctx.runMutation(internal.repositories.skippedFile,{jobId:job._id,path:file.path,reason:exclusionReason(file,manifest.gitignore)!,leaseId});
          await ctx.runMutation(internal.repositories.removeIndexedFile, {
            repositoryId: data.repo._id,
            jobId:job._id,
            leaseId,
            path: file.path,
          });
          continue;
        }
        await loadGrammars([file.path]);
        const index = indexRepository([file], allPaths);
        if (!index.files.length) continue;
        const moduleReferences=[...new Map((index.moduleReferences??[]).filter(r=>r.path===file.path).map(({specifier,resolvedPath})=>[specifier,{specifier,resolvedPath}])).values()];
        if (process.env.EMBEDDING_MODEL) {
          // Chunk-level embeddings at definition boundaries; unchanged blobs with the current
          // model are skipped, so re-index backfills are idempotent.
          const embedder = new Embeddings(inferenceBilling(ctx)), started = Date.now();
          const state = await ctx.runQuery(internal.embeddings.chunkState, { repositoryId: data.repo._id, path: file.path });
          if (state?.sha !== file.sha || state.model !== embedder.model) {
            // Variable declarations (including locals) are not chunk boundaries.
            const chunks = semanticChunks(index.files[0].content, index.symbols.filter((symbol) => symbol.path === file.path && symbol.kind !== "VariableDeclaration")).slice(0, 64);
            const embedded = chunks.length ? await embedder.embed(chunks.map((c) => `${file.path}:${c.startLine}-${c.endLine}${c.symbol ? " " + c.symbol : ""}\n${c.content}`)) : { vectors: [], tokens: 0, estimatedCost: 0 };
            await ctx.runMutation(internal.embeddings.saveChunks, { repositoryId: data.repo._id, jobId: job._id, leaseId, path: file.path, sha: file.sha, model: embedder.model!, chunks: chunks.map((c, i) => ({ startLine: c.startLine, endLine: c.endLine, ...(c.symbol ? { symbol: c.symbol } : {}), vector: embedded.vectors[i] })) });
            if (embedded.tokens) await ctx.runMutation(internal.embeddings.usage, { repositoryId: data.repo._id, tokens: embedded.tokens, estimatedCost: embedded.estimatedCost, durationMs: Date.now() - started });
          }
        }
        const storageId = await ctx.storage.store(
          new Blob([index.files[0].content], { type: "text/plain" }),
        );
        await ctx.runMutation(internal.repositories.indexedFile, {
          repositoryId: data.repo._id,
          jobId: job._id,
          leaseId,
          path: file.path,
          sha: file.sha,
          storageId,
          graphVersion: INDEX_GRAPH_VERSION,
          // Missing/oversized receipts disable skipping; a partial receipt must
          // never masquerade as complete dependency coverage.
          graphModuleReferences: moduleReferences.length<=500&&Buffer.byteLength(JSON.stringify(moduleReferences),"utf8")<=64000?moduleReferences:undefined,
          chunks: sourceChunks(index.files[0].content),
          symbols: index.symbols.map((s) => ({
            name: s.name,
            kind: s.kind,
            line: s.line,
            exported: s.exported,
          })),
          relationships: index.relationships.map((r) => ({
            from: r.from,
            to: r.to.slice(0, 500),
            kind: r.kind,
            ...(r.symbol ? { symbol: r.symbol.slice(0, 200) } : {}),
            ...(r.resolved !== undefined ? { resolved: r.resolved } : {}),
          })),
        });
      }
      const next = Math.min(cursor + 20, manifest.entries.length);
      if (next < manifest.entries.length)
        await ctx.runMutation(internal.repositories.indexProgress, {
          jobId: job._id,
          cursor: next,
          leaseId,
        });
      else {
        if(inventory&&JSON.stringify(await p4!.project(inventory.project.id))!==JSON.stringify(inventory.project))throw new Error("P4 project views changed before index completion");
        // Sweep stored files missing from this revision in small batches before completing.
        const stale=[...(await fileInventory(ctx,data.repo._id)).keys()].filter(path=>!pathSet.has(path));
        for(let i=0;i<stale.length;i+=10)if(!await ctx.runMutation(internal.repositories.removeIndexedFiles,{repositoryId:data.repo._id,jobId:job._id,leaseId,paths:stale.slice(i,i+10)}))return;
        const knowledgePaths=manifest.changedPaths?.slice(0,500);
        const finished=await ctx.runMutation(internal.repositories.finishIndex, {
          repositoryId: data.repo._id,
          jobId: job._id,
          sha: manifest.sha,
          leaseId,
          processed: allPaths.length,
          knowledgePaths,
          removedPaths: knowledgePaths?.filter(path=>!pathSet.has(path)),
        });
        // Submitted P4 inventories remain available for exact-baseline shelf ingestion.
        if(finished&&!job.nativeDepot)await ctx.storage.delete(job.manifestStorageId);
        if(finished)console.log(
          JSON.stringify({
            event: "index.completed",
            repositoryId: data.repo._id,
            sha: manifest.sha,
            files: allPaths.length,
          }),
        );
      }
    } catch (error) {
      await ctx.runMutation(internal.repositories.finishIndex, {
        repositoryId: job.repositoryId,
        jobId: job._id,
        sha: job.sha,
        leaseId,
        error: error instanceof Error ? error.message : "Index batch failed",
      });
      throw error;
    }
  },
});

export const review = internalAction({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, args) => {
    const stepStarted = Date.now();
    const state = await ctx.runQuery(internal.reviews.data, args);
    if (["completed", "cancelled"].includes(state.review.status)) return;
    if(state.review.nativeP4){await ctx.runAction(internal.p4ReviewJobs.run,args);return;}
    const indexState = await ctx.runQuery(internal.repositories.data, {
      repositoryId: state.review.repositoryId,
    });
    if (
      !indexState.repo.indexedSha &&
      indexState.repo.indexStatus !== "failed"
    ) {
      if (indexState.repo.indexStatus !== "indexing")
        await ctx.runAction(internal.jobs.index, {
          repositoryId: state.review.repositoryId,
        });
      await ctx.scheduler.runAfter(3000, internal.jobs.review, args);
      return;
    }
    if (!indexState.repo.indexedSha) {
      await ctx.runMutation(internal.reviews.finished, {
        ...args,
        error: "Repository indexing failed; re-index before reviewing",
      });
      return;
    }
    let check: { scm: Scm; repository: string; id: number } | null = null;
    try {
      const claimed = await ctx.runMutation(internal.reviews.stage, {
        ...args,
        status: "ingesting",
      });
      if (!claimed) return;
      const { repo, settings, rules, preferences } = await ctx.runQuery(
        internal.repositories.data,
        { repositoryId: state.review.repositoryId },
      );
      if (!repo.enabled) throw new Error("Repository disabled");
      const github = await provider(ctx,repo);
      const pr = await github.pullRequest(repo.fullName, state.review.prNumber);
      if (pr.head.sha !== state.review.headSha || pr.state !== "open" || pr.revisionKey !== state.review.revisionKey) {
        await ctx.runMutation(internal.reviews.stage, {...args,status:"cancelled",detail:"Obsolete revision or closed change"});
        return;
      }
      if (state.review.resultStorageId) {
        const stored = await ctx.storage.get(state.review.resultStorageId);
        if (!stored) throw new Error("Persisted review result unavailable");
        const result = z
          .object({
            summary: z.string(),
            repositoryContext:z.custom<RepositoryContext>().optional(),
            integrationScopes:z.array(z.object({id:z.custom<Id<"integrationConnections">>(),generation:z.number()})).optional(),
            metadata: z.object({context:z.array(z.object({path:z.string()})).optional(),carriedForward:z.array(findingSchema).optional()}).optional(),
            findings: z.array(
              findingSchema.and(
                z.object({
                  fingerprint: z.string(),
                  agent: z.string(),
                  commitSha: z.string(),
                }),
              ),
            ),
          })
          .parse(JSON.parse(await stored.text()));
        await ctx.runMutation(internal.reviews.stage, {
          ...args,
          status: "publishing",
          detail: "Resuming persisted result without new model calls",
        });
        if(result.metadata?.context?.some(c=>c.path.startsWith("context/"))&&!result.repositoryContext)throw new Error("Legacy cross-repository result has no authorization receipt; re-review");
        if(result.repositoryContext){if(result.repositoryContext.repositoryId!==repo._id||result.repositoryContext.actor!==pr.user.login||result.repositoryContext.providerActor&&result.repositoryContext.providerActor.externalId!==pr.authorExternalId||result.repositoryContext.githubActorId&&result.repositoryContext.githubActorId!==pr.authorExternalId)throw new Error("Saved repository context author or repository changed");await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:result.repositoryContext});}
        await ctx.runQuery(internal.integrations.validate,{repositoryId:repo._id,scopes:result.integrationScopes??[]});
        const published = await github.publish(
          repo.fullName,
          pr.number,
          state.review.headSha,
          result.summary,
          result.findings.slice(0, settings.maxComments),
          args.reviewId,
          settings.commentStyle,
          state.review.revisionKey,
          result.findings.length+(result.metadata?.carriedForward?.length??0),
        );
        if(result.repositoryContext)await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:result.repositoryContext});
        await ctx.runMutation(internal.reviews.finished, {
          ...args,
          githubReviewId: published.id,
          comments: published.comments,
        });
        const verified = [...result.findings, ...(result.metadata?.carriedForward ?? [])];
        await finishCheck(await beginCheck(ctx, github, args.reviewId, repo.fullName, state.review.headSha), { conclusion: checkConclusion(verified, settings.checkFailureSeverity), title: verified.length ? `${verified.length} verified finding${verified.length === 1 ? "" : "s"}` : "No verified findings", summary: verified.length ? verified.slice(0, 10).map((f) => `- **${f.severity}** ${f.title} (\`${f.filePath}:${f.startLine}\`)`).join("\n") : "OpenReview found no verified issues in this revision.", detailsUrl: dashboardUrl(args.reviewId) });
        return;
      }
      if (pr.head.sha !== state.review.headSha || pr.state !== "open") {
        await ctx.runMutation(internal.reviews.stage, {
          ...args,
          status: "cancelled",
          detail: "Obsolete head or closed PR",
        });
        return;
      }
      if (pr.draft && !settings.drafts) {
        await ctx.runMutation(internal.reviews.stage, {
          ...args,
          status: "cancelled",
          detail: "Draft reviews disabled",
        });
        return;
      }
      await ctx.runMutation(internal.reviews.recordPr, {
        ...args,
        title: pr.title,
        author: pr.user.login,
        url: pr.html_url,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        state: pr.state,
        commits: pr.commits.map((c) => c.sha),
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
      });
      if(await ctx.runMutation(internal.runtime.request,{reviewId:args.reviewId}))return;
      check = await beginCheck(ctx, github, args.reviewId, repo.fullName, pr.head.sha);
      // Incremental review when the last reviewed head is an ancestor of this head.
      const previousHead = await ctx.runQuery(internal.reviews.previousHead, args);
      const comparison = previousHead && github.compare ? await github.compare(repo.fullName, previousHead, pr.head.sha).catch(() => "unavailable" as const) : undefined;
      const scope = incrementalDiff(pr.diff, github.compare ? previousHead ?? undefined : undefined, comparison);
      const graph = await ctx.runQuery(internal.context.related, {
        repositoryId: repo._id,
        paths: pr.diff.map((f) => f.path),
        identifiers: [
          ...new Set(
            pr.diff.flatMap((f) => f.patch.match(/[A-Za-z_]\w{3,}/g) ?? []),
          ),
        ].slice(0, 100),
      });
      // Multi-hop graph neighbours (callers/callees up to two hops) widen retrieval beyond one hop.
      const neighbors = await ctx.runQuery(internal.context.neighborhood, { repositoryId: repo._id, paths: pr.diff.map((f) => f.path), hops: 2, limit: 30 });
      const tree = await github.tree(repo.fullName, pr.head.sha);
      const history = await ctx.runQuery(internal.reviews.history, {
        repositoryId: repo._id,
      });
      const changedPaths = new Set(pr.diff.map((file) => file.path));
      let historicalFindings = history
        .filter(
          (finding) =>
            changedPaths.has(finding.filePath) ||
            finding.evidence.some((e) => graph.paths.includes(e.filePath)),
        )
        .slice(0, 20)
        .map((finding) => ({
          title: finding.title,
          category: z.enum(categories).parse(finding.category),
          severity: z.enum(severities).parse(finding.severity),
          filePath: finding.filePath,
          impact: finding.impact,
          status: finding.status,
        }));
      const head = new Map(tree.map((f) => [f.path, f]));
      // Hybrid retrieval: chunk vectors (when configured) + full-text identifiers + graph proximity.
      const identifiers = [...new Set(pr.diff.flatMap((f) => f.patch.match(/^\+.*$/gm)?.join("\n").match(/[A-Za-z_]\w{3,}/g) ?? []))].slice(0, 6);
      const textHits = (await Promise.all(identifiers.map((identifier) => ctx.runQuery(internal.agentTools.search, { repositoryId: repo._id, query: identifier })))).flatMap((hits) => hits.map((hit, rank) => ({ path: hit.path, score: 1 / (1 + rank), startLine: hit.line })));
      const vectorHits = await semanticHits(ctx, repo._id, pr.title + "\n" + pr.diff.map((f) => f.path + "\n" + f.patch.slice(0, 3000)).join("\n"), 24);
      const hybrid = hybridRank({ vector: vectorHits, text: textHits, graph: neighbors.map((n) => ({ path: n.path, score: n.score })) }, 20);
      const semanticPaths = hybrid.filter((hit) => hit.reason.includes("semantic")).map((hit) => hit.path);
      const paths = [
        ...new Set([
          ...pr.diff.filter((d) => d.status !== "removed").map((f) => f.path),
          ...graph.paths,
          ...neighbors.map((n) => n.path),
          ...state.findings.flatMap((finding) => [finding.filePath, ...finding.evidence.map((e) => e.filePath)]),
          ...semanticPaths,
          ...hybrid.map((hit) => hit.path),
          ...historicalFindings.map((finding) => finding.filePath),
          ...(repo.knowledgePaths ?? []).slice(0, 10),
        ]),
      ];
      const sources: SourceFile[] = [];
      let bytes = 0;
      const cached = new Map((await indexedFiles(ctx, repo._id, paths.filter((path) => head.has(path)))).map((f) => [f.path, f]));
      for (const path of paths) {
        const entry = head.get(path);
        if (!entry || bytes > 500000) continue;
        const old = cached.get(path);
        const blob =
          old?.sha === entry.sha ? await ctx.storage.get(old.storageId) : null;
        const file = blob
          ? { path, sha: entry.sha, content: await blob.text() }
          : await github.blob(repo.fullName, path, entry.sha);
        bytes += file.content.length;
        sources.push(file);
      }
      const cross=await ctx.runAction(internal.repositoryContextJobs.retrieve,{repositoryId:repo._id,actor:pr.user.login,authorExternalId:pr.authorExternalId,identifiers:[...new Set(pr.diff.flatMap(f=>f.patch.match(/[A-Za-z_]\w{3,}/g)??[]))].slice(0,30)});
      sources.push(...cross.files);
      const permittedHistory=new Set(history.filter(f=>hasCurrentRepositoryEvidence(f,cross.files)).map(f=>f.title+"\0"+f.filePath));
      historicalFindings=historicalFindings.filter(f=>permittedHistory.has(f.title+"\0"+f.filePath));
      const clusterHints=cross.hints;
      const requirements=await ctx.runAction(internal.integrationJobs.requirements,{repositoryId:repo._id,references:[pr.title,pr.body??"",pr.head.ref].join("\n")});
      sources.push(...requirements.files);
      const integrationContext={repositoryId:repo._id,scopes:requirements.scopes,repositoryContext:cross.receipt??undefined};
      const existingFindings = state.findings.filter(f=>hasCurrentRepositoryEvidence(f,cross.files)).map((f) => ({
        ...findingSchema.parse(f),
        fingerprint: f.fingerprint,
        agent: f.agent,
        commitSha: f.commitSha,
      }));
      const modelProvider = budgetModel(ctx,settings.model, {
        get: (key) =>
          ctx.runQuery(internal.cache.get, {
            organizationId: repo.organizationId,
            key,
            context:integrationContext,
          }),
        set: async (key, result) => {
          await ctx.runMutation(internal.cache.set, {
            organizationId: repo.organizationId,
            key,
            result,
            context:integrationContext,
          });
        },
      });
      const model: ModelProvider = {
        generate: async (request, validator) => {
          if(cross.receipt)await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:cross.receipt});
          const started = Date.now();
          const result = await modelProvider
            .generate(request, validator)
            .catch(async (error) => {
              await ctx.runMutation(internal.reviews.recordCall, {
                reviewId: args.reviewId,
                usage: error instanceof ModelFailure ? error.usage : {
                  task: request.task,
                  provider: process.env.LLM_PROVIDER ?? "openai",
                  model: configuredModel(request.task, settings.model),
                  inputTokens: 0,
                  outputTokens: 0,
                  estimatedCost: 0,
                  latencyMs: Date.now() - started,
                  cached: false,
                },
                error: redact(
                  error instanceof Error ? error.message : "Model failed",
                ).slice(0, 4000),
              });
              throw error;
            });
          await ctx.runMutation(internal.reviews.recordCall, {
            reviewId: args.reviewId,
            usage: result.usage,
          });
          if(cross.receipt)await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:cross.receipt});
          return result;
        },
        runTools: async (request) => {
          if(cross.receipt)await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:cross.receipt});
          try {
            const turn = await modelProvider.runTools(request);
            await ctx.runMutation(internal.reviews.recordCall, { reviewId: args.reviewId, usage: turn.usage });
            return turn;
          } catch (error) {
            if (error instanceof ModelFailure) await ctx.runMutation(internal.reviews.recordCall, { reviewId: args.reviewId, usage: error.usage, error: redact(error.message).slice(0, 4000) });
            throw error;
          }
        },
      };
      const agentic = settings.reviewEngine === "agentic";
      const result = {...await reviewChange(
        {
          repository: repo.fullName,
          coverageLimits:[...(scope.note?[scope.note]:[]),...requirements.coverage,...cross.coverage,...(state.findings.some(f=>!hasCurrentRepositoryEvidence(f,cross.files))?["Some prior cross-repository findings were withheld because their exact pinned evidence was not fetched in the current authorized context; they remain unresolved."]:[])],
          baseSha: pr.base.sha,
          headSha: pr.head.sha,
          title: pr.title,
          description: `${pr.body ?? ""}\nCI: ${JSON.stringify(pr.checks)}\nNative reviewer decisions (context, not OpenReview approval or runtime evidence): ${JSON.stringify(pr.reviews.map(r=>({state:r.state,reviewedRevision:r.commit_id}))).slice(0,10000)}\nExisting comments: ${JSON.stringify(pr.comments.map((c) => ({ path: c.path, body: c.body.slice(0, 2000) }))).slice(0, 10000)}`,
          files: sources,
          contextHints: [
            ...requirements.files.map(f=>({path:f.path,reason:"authorized requirements from "+(f.provenance?.repository??"external integration")+" fetched at "+f.sha,score:100})),
            ...clusterHints,
            ...(repo.knowledgePaths ?? []).slice(0, 10).map((path) => ({
              path,
              reason: "recently indexed change",
              score: 15,
            })),
            ...historicalFindings.map((finding) => ({
              path: finding.filePath,
              reason: "historical finding",
              score: 25,
            })),
            ...hybrid.map((hit) => ({
              path: hit.path,
              reason: `hybrid retrieval: ${hit.reason}${hit.startLine ? ` (lines ${hit.startLine}${hit.endLine ? "–" + hit.endLine : ""})` : ""}`,
              score: Math.round(20 + 30 * hit.score),
            })),
            ...neighbors.map((n) => ({ path: n.path, reason: `code graph ${n.via} (${n.hops} hop${n.hops > 1 ? "s" : ""})`, score: Math.round(40 * Math.min(1, n.score)) })),
          ],
          diff: scope.diff,
          ...(scope.incremental ? { fullDiff: pr.diff } : {}),
          skippedFiles: pr.omitted,
          sourceLink: summaryLink(github, repo.fullName, pr.head.sha),
          mode: z.enum(["fast", "standard", "deep"]).parse(settings.mode),
          rules: rules.map((r) => ({
            id: r._id,
            instructions: r.instructions,
            severity: z.enum(severities).parse(r.severity),
            category: r.category,
            globs: r.globs,
            enabled: r.enabled,
          })),
          preferences,
          existingFindings,
          historicalFindings,
          runtimeEvidence: state.review.runtimeEvidence,
          settings: {
            minimumConfidence: settings.minimumConfidence,
            severityThreshold: z
              .enum(severities)
              .parse(settings.severityThreshold),
            maxComments: settings.maxComments,
            ignoredPaths: settings.ignoredPaths,
            categories: state.review.category
              ? [z.enum(categories).parse(state.review.category)]
              : settings.categories.map((c) => z.enum(categories).parse(c)),
            instructions: settings.instructions,
            summarySections:settings.summarySections,
          },
        },
        model,
        async (status) => {
          await ctx.runMutation(internal.reviews.stage, { ...args, status });
        },
        undefined,
        agentic ? { engine: "agentic", tools: reviewToolbox(ctx, repo, pr.head.sha, head, (repository, path, sha) => github.blob(repository, path, sha), sources), agent: reviewAgentHooks(ctx, args.reviewId, stepStarted) } : {},
      ),integrationScopes:requirements.scopes,repositoryContext:cross.receipt??undefined};
      const storageId = await ctx.storage.store(
        new Blob([JSON.stringify(result)], { type: "application/json" }),
      );
      await ctx.runMutation(internal.reviews.save, {
        ...args,
        storageId,
        summary: result.summary,
        integrationScopes:requirements.scopes,
        repositoryContext:cross.receipt??undefined,
        approvalAssessment: result.metadata.approvalAssessment,
        reviewScore: result.metadata.reviewScore,
        coverageLimits: result.metadata.coverageLimits,
        findings: [...result.findings,...(result.metadata.carriedForward??[])],
        resolved: result.metadata.resolvedFingerprints,
        usage: result.usage,
      }).catch(async(error)=>{await ctx.storage.delete(storageId);throw error;});
      await ctx.runMutation(internal.reviews.stage, {
        ...args,
        status: "publishing",
      });
      await ctx.runQuery(internal.integrations.validate,{repositoryId:repo._id,scopes:requirements.scopes});
      if(cross.receipt)await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:cross.receipt});
      const published = await github.publish(
        repo.fullName,
        pr.number,
        pr.head.sha,
        result.summary,
        result.findings.slice(0, settings.maxComments),
        args.reviewId,
        settings.commentStyle,
          state.review.revisionKey,
          result.findings.length+(result.metadata.carriedForward?.length??0),
      );
      if(result.repositoryContext)await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:result.repositoryContext});
      await ctx.runMutation(internal.reviews.finished, {
        ...args,
        githubReviewId: published.id,
        comments: published.comments,
      });
      await resolveFixedThreads(ctx, github, repo._id, repo.fullName, pr.number, pr.head.sha, result.metadata.resolvedFingerprints);
      const verified = [...result.findings, ...(result.metadata.carriedForward ?? [])];
      await finishCheck(check, { conclusion: checkConclusion(verified, settings.checkFailureSeverity), title: verified.length ? `${verified.length} verified finding${verified.length === 1 ? "" : "s"}` : "No verified findings", summary: [verified.length ? verified.slice(0, 10).map((f) => `- **${f.severity}** ${f.title} (\`${f.filePath}:${f.startLine}\`)`).join("\n") : "OpenReview found no verified issues in this revision.", ...(result.metadata.coverageLimits?.length ? ["", "Coverage limits:", ...result.metadata.coverageLimits.map((l) => "- " + l)] : [])].join("\n"), detailsUrl: dashboardUrl(args.reviewId) });
    } catch (error) {
      if (error instanceof AgentSuspended && await ctx.runMutation(internal.reviews.suspendAgent, args)) {
        console.log(JSON.stringify({ event: "review.agent_suspended", reviewId: args.reviewId, toolCalls: error.state.toolCalls, turns: error.state.turns }));
        return;
      }
      const message = error instanceof Error ? error.message : "Review failed";
      await finishCheck(check, { conclusion: "neutral", title: "Review could not be completed", summary: "OpenReview could not complete this review: " + redact(message).slice(0, 500), detailsUrl: dashboardUrl(args.reviewId) });
      console.error(
        JSON.stringify({
          event: "review.failed",
          reviewId: args.reviewId,
          error: message,
        }),
      );
      await ctx.runMutation(internal.reviews.finished, {
        ...args,
        error: message,
      });
    }
  },
});

export const diagnostics=action({args:{token:v.string(),reviewId:v.id("reviews")},handler:async(ctx,a):Promise<{suppressions:{title:string;agent:string;reason:string}[];coverageLimits:string[];skippedFiles:{path:string;reason:string}[];failedSpecialists:{category:string;error:string}[];diagrams:string[]} | null>=>{
 const {review}=await ctx.runQuery(api.reviews.detail,a);
 if(!review.resultStorageId)return null;
 const blob=await ctx.storage.get(review.resultStorageId);if(!blob||blob.size>2000000)throw new Error("Saved review diagnostics unavailable");
 const result=z.object({diagrams:z.array(z.string()).default([]),metadata:z.object({suppressions:z.array(z.object({title:z.string(),agent:z.string(),reason:z.string()})).default([]),coverageLimits:z.array(z.string()).default([]),skippedFiles:z.array(z.object({path:z.string(),reason:z.string()})).default([]),failedSpecialists:z.array(z.object({category:z.string(),error:z.string()})).default([])})}).parse(JSON.parse(await blob.text()));
 const evidence=review.runtimeEvidence?.headSha===review.headSha?review.runtimeEvidence:undefined;
 return {...result.metadata,diagrams:result.diagrams.filter(validSequence).slice(0,1),suppressions:result.metadata.suppressions.map(s=>({...s,title:executionExplanation(s.title,evidence),reason:executionExplanation(s.reason,evidence)}))};
}});

// Line links for the summary issue table on providers with stable line anchors.
function summaryLink(scm: Scm, repository: string, sha: string) {
  const anchor = scm instanceof Github ? (start: number, end: number) => `#L${start}${end > start ? "-L" + end : ""}` : scm instanceof Gitlab ? (start: number, end: number) => `#L${start}${end > start ? "-" + end : ""}` : undefined;
  return anchor ? (path: string, start: number, end: number) => { try { return scm.sourceUrl(repository, sha, path) + anchor(start, end); } catch { return undefined; } } : undefined;
}

// Thread hygiene: reply to and resolve OpenReview's own threads for findings verified fixed.
// Failures are logged and never fail an already published review.
async function resolveFixedThreads(ctx: ActionCtx, scm: Scm, repositoryId: Id<"repositories">, repository: string, number: number, sha: string, fingerprints: string[]) {
  if (!scm.resolveFindingThreads || !fingerprints.length) return;
  try {
    const comments = await ctx.runQuery(internal.reviews.findingCommentIds, { repositoryId, prNumber: number, fingerprints });
    const result = await scm.resolveFindingThreads(repository, number, comments.map((c) => ({ commentId: c.commentId, marker: `resolved:${c.fingerprint}:${sha}`, body: `Resolved: OpenReview verified this finding is fixed in \`${sha.slice(0, 7)}\`.` })));
    console.log(JSON.stringify({ event: "review.threads_resolved", repositoryId, number, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: "review.thread_resolution_failed", repositoryId, number, error: redact(error instanceof Error ? error.message : "failed").slice(0, 300) }));
  }
}

const dashboardUrl = (reviewId: Id<"reviews">) => { const app = process.env.APP_URL; return app && /^https:\/\//.test(app) ? new URL(`/dashboard/pulls/${encodeURIComponent(reviewId)}`, app).href : undefined; };
// GitHub check runs (checks:write only; otherwise the provider returns null and nothing happens).
async function beginCheck(ctx: ActionCtx, scm: Scm, reviewId: Id<"reviews">, repository: string, sha: string) {
  if (!scm.startCheckRun) return null;
  try {
    const existing = await ctx.runQuery(internal.reviews.checkRun, { reviewId });
    if (existing && existing.head === sha) return { scm, repository, id: existing.id };
    const id = await scm.startCheckRun(repository, sha, reviewId, dashboardUrl(reviewId));
    if (id === null) return null;
    await ctx.runMutation(internal.reviews.setCheckRun, { reviewId, checkRunId: id, checkRunHead: sha });
    return { scm, repository, id };
  } catch (error) {
    console.error(JSON.stringify({ event: "review.check_run_failed", reviewId, error: redact(error instanceof Error ? error.message : "failed").slice(0, 300) }));
    return null;
  }
}
async function finishCheck(check: { scm: Scm; repository: string; id: number } | null, result: { conclusion: CheckConclusion; title: string; summary: string; detailsUrl?: string }) {
  if (!check?.scm.completeCheckRun) return;
  try { await check.scm.completeCheckRun(check.repository, check.id, result); }
  catch (error) { console.error(JSON.stringify({ event: "review.check_run_failed", error: redact(error instanceof Error ? error.message : "failed").slice(0, 300) })); }
}
