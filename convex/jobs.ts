"use node";
import {budgetModel,inferenceBilling} from "./budgetModel";
import {executionExplanation} from "../src/execution-claims";
import { action,internalAction } from "./_generated/server";
import { api,internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {hasCurrentRepositoryEvidence} from "../src/context-history";
import type {RepositoryContext} from "./repositoryContext";
import { z } from "zod";
import { provider } from "./scm";
import {parseP4SubmittedInventory} from "../src/p4-index";
import {P4CodeReview,p4Credential} from "../src/perforce";
import {decryptCredential} from "../src/credentials";
import { eligibleFile, exclusionReason, indexRepository, moduleReferencesCurrent, redact } from "../src/engine/indexer";
import {INDEX_GRAPH_VERSION} from "../src/engine/index-version";
// Validate shared summaries against recorded test evidence before native publication.
import { reviewChange } from "../src/engine/review";
import { sourceChunks } from "../src/engine/chunks";
import { Embeddings } from "../src/engine/embeddings";
import { ModelFailure } from "../src/engine/model";
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
    const { repo, files } = await ctx.runQuery(
      internal.repositories.data,
      args,
    );
    if (!repo.enabled) return;
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
    const known = new Map(files.map((f) => [f.path, f.sha]));
    const indexedPaths = new Set(entries.map((entry) => entry.path));
    const changedPaths = [
      ...entries.filter((f) => known.get(f.path) !== f.sha).map((f) => f.path),
      ...files
        .filter((file) => !indexedPaths.has(file.path))
        .map((file) => file.path),
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
      const known = new Map(data.files.map((f) => [f.path, f]));
      const allPaths = manifest.entries.map((f) => f.path);
      const pathSet=new Set(allPaths);
      const batch=manifest.entries.slice(cursor,cursor+20);
      const receipts=await ctx.runQuery(internal.repositories.indexModuleReferences,{repositoryId:data.repo._id,paths:batch.map(f=>f.path)});
      const references=new Map(receipts.filter(r=>r!==null).map(r=>[r.path,r]));
      for (const entry of batch) {
        const previous=known.get(entry.path);
        const receipt=references.get(entry.path);
        if (previous?.sha === entry.sha && previous.graphVersion === INDEX_GRAPH_VERSION && receipt?.sha===entry.sha && receipt.graphVersion===INDEX_GRAPH_VERSION && moduleReferencesCurrent(entry.path,receipt.references,pathSet)) {
          if (!process.env.EMBEDDING_MODEL) continue;
          const cachedEmbedding = await ctx.runQuery(
            internal.embeddings.existing,
            { repositoryId: data.repo._id, path: entry.path },
          );
          if (
            cachedEmbedding?.sha === entry.sha &&
            cachedEmbedding.model === process.env.EMBEDDING_MODEL
          )
            continue;
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
        const index = indexRepository([file], allPaths);
        if (!index.files.length) continue;
        const moduleReferences=[...new Map((index.moduleReferences??[]).filter(r=>r.path===file.path).map(({specifier,resolvedPath})=>[specifier,{specifier,resolvedPath}])).values()];
        if (process.env.EMBEDDING_MODEL) {
          const embedder = new Embeddings(inferenceBilling(ctx)),
            started = Date.now();
          const oldEmbedding = await ctx.runQuery(
            internal.embeddings.existing,
            { repositoryId: data.repo._id, path: file.path },
          );
          if (
            oldEmbedding?.sha !== file.sha ||
            oldEmbedding.model !== embedder.model
          ) {
            const embedded = await embedder.embed([
              file.path + "\n" + index.files[0].content,
            ]);
            await ctx.runMutation(internal.embeddings.save, {
              repositoryId: data.repo._id,
              jobId:job._id,
              leaseId,
              path: file.path,
              sha: file.sha,
              model: embedder.model!,
              vector: embedded.vectors[0],
            });
            await ctx.runMutation(internal.embeddings.usage, {
              repositoryId: data.repo._id,
              tokens: embedded.tokens,
              estimatedCost: embedded.estimatedCost,
              durationMs: Date.now() - started,
            });
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
            to: r.to,
            kind: r.kind,
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
        const finished=await ctx.runMutation(internal.repositories.finishIndex, {
          repositoryId: data.repo._id,
          jobId: job._id,
          sha: manifest.sha,
          leaseId,
          paths: allPaths,
          knowledgePaths: manifest.changedPaths?.slice(0,500),
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
        paths: [],
        error: error instanceof Error ? error.message : "Index batch failed",
      });
      throw error;
    }
  },
});

export const review = internalAction({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, args) => {
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
    try {
      const claimed = await ctx.runMutation(internal.reviews.stage, {
        ...args,
        status: "ingesting",
      });
      if (!claimed) return;
      const { repo, settings, rules, preferences, files } = await ctx.runQuery(
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
      const graph = await ctx.runQuery(internal.context.related, {
        repositoryId: repo._id,
        paths: pr.diff.map((f) => f.path),
        identifiers: [
          ...new Set(
            pr.diff.flatMap((f) => f.patch.match(/[A-Za-z_]\w{3,}/g) ?? []),
          ),
        ].slice(0, 100),
      });
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
      const semanticPaths: string[] = [];
      if (process.env.EMBEDDING_MODEL) {
        const embedder = new Embeddings(inferenceBilling(ctx));
        const embedded = await embedder.embed([
          redact(
            pr.title +
              "\n" +
              pr.diff
                .map((f) => f.path + "\n" + f.patch.slice(0, 3000))
                .join("\n"),
          ),
        ]);
        await ctx.runMutation(internal.embeddings.usage, {
          repositoryId: repo._id,
          tokens: embedded.tokens,
          estimatedCost: embedded.estimatedCost,
          durationMs: 0,
        });
        const matches = await ctx.vectorSearch("embeddings", "by_vector", {
          vector: embedded.vectors[0],
          limit: 12,
          filter: (q) => q.eq("scope", `${repo._id}:${embedder.model}`),
        });
        semanticPaths.push(
          ...(await ctx.runQuery(internal.embeddings.paths, {
            ids: matches.map((m) => m._id),
            repositoryId: repo._id,
          })),
        );
      }
      const paths = [
        ...new Set([
          ...pr.diff.filter((d) => d.status !== "removed").map((f) => f.path),
          ...graph.paths,
          ...state.findings.flatMap((finding) => [finding.filePath, ...finding.evidence.map((e) => e.filePath)]),
          ...semanticPaths,
          ...historicalFindings.map((finding) => finding.filePath),
          ...(repo.knowledgePaths ?? []).slice(0, 10),
        ]),
      ];
      const sources: SourceFile[] = [];
      let bytes = 0;
      const cached = new Map(files.map((f) => [f.path, f]));
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
                  model:
                    process.env[
                      `LLM_MODEL_${request.task.split(":")[0].toUpperCase()}`
                    ] ||
                    settings.model ||
                    process.env.LLM_MODEL ||
                    "gpt-4.1",
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
      };
      const result = {...await reviewChange(
        {
          repository: repo.fullName,
          coverageLimits:[...requirements.coverage,...cross.coverage,...(state.findings.some(f=>!hasCurrentRepositoryEvidence(f,cross.files))?["Some prior cross-repository findings were withheld because their exact pinned evidence was not fetched in the current authorized context; they remain unresolved."]:[])],
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
            ...semanticPaths.map((path) => ({
              path,
              reason: "semantic embedding match",
              score: 35,
            })),
          ],
          diff: pr.diff,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Review failed";
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

export const diagnostics=action({args:{token:v.string(),reviewId:v.id("reviews")},handler:async(ctx,a):Promise<{suppressions:{title:string;agent:string;reason:string}[];coverageLimits:string[]} | null>=>{
 const {review}=await ctx.runQuery(api.reviews.detail,a);
 if(!review.resultStorageId)return null;
 const blob=await ctx.storage.get(review.resultStorageId);if(!blob||blob.size>2000000)throw new Error("Saved review diagnostics unavailable");
 const result=z.object({metadata:z.object({suppressions:z.array(z.object({title:z.string(),agent:z.string(),reason:z.string()})).default([]),coverageLimits:z.array(z.string()).default([])})}).parse(JSON.parse(await blob.text()));
 const evidence=review.runtimeEvidence?.headSha===review.headSha?review.runtimeEvidence:undefined;
 return {...result.metadata,suppressions:result.metadata.suppressions.map(s=>({...s,title:executionExplanation(s.title,evidence),reason:executionExplanation(s.reason,evidence)}))};
}});
