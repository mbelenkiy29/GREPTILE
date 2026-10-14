"use node";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { agentStateSchema, type AgentHooks, type AgentState, type AgentToolbox } from "../src/engine/agent";
import type { SourceFile } from "../src/engine/types";
import { indexedFiles } from "./fileReads";

type Blob = (repository: string, path: string, sha: string) => Promise<SourceFile>;
// Binds every agent tool to one repository and one head revision. File reads always resolve to
// the PR head tree (indexed content is reused only when its blob SHA matches), so evidence is
// revision-consistent; search/definition/reference results are labelled with the indexed revision.
export function reviewToolbox(ctx: ActionCtx, repo: Doc<"repositories">, headSha: string, head: Map<string, { sha: string; size?: number }>, blob: Blob, preloaded: SourceFile[]): AgentToolbox {
  const repositoryId = repo._id;
  return {
    revisions: { head: headSha, index: repo.indexedSha },
    searchCode: (query) => ctx.runQuery(internal.agentTools.search, { repositoryId, query }),
    async readFile(path) {
      const entry = head.get(path);
      if (!entry || (entry.size ?? 0) > 200_000) return null;
      const known = preloaded.find((f) => f.path === path && !f.provenance && f.sha === entry.sha);
      if (known) return { path, content: known.content, revision: headSha };
      const [cached] = await indexedFiles(ctx, repositoryId, [path]);
      const stored = cached?.sha === entry.sha ? await ctx.storage.get(cached.storageId) : null;
      if (stored) return { path, content: await stored.text(), revision: headSha };
      const file = await blob(repo.fullName, path, entry.sha);
      return file.content || !file.size ? { path, content: file.content, revision: headSha } : null;
    },
    findDefinition: (symbol) => ctx.runQuery(internal.agentTools.definitions, { repositoryId, symbol }),
    findReferences: (symbol) => ctx.runQuery(internal.agentTools.references, { repositoryId, symbol }),
    listDirectory: (path) => ctx.runQuery(internal.agentTools.directory, { repositoryId, path }),
    relatedFiles: (path) => ctx.runQuery(internal.agentTools.related, { repositoryId, path }),
    pastFindings: (path) => ctx.runQuery(internal.agentTools.pastFindings, { repositoryId, path }),
  };
}
// Persist the tool loop between steps; suspend before the action time limit (AGENT_STEP_SECONDS).
export function reviewAgentHooks(ctx: ActionCtx, reviewId: Id<"reviews">, stepStarted: number): AgentHooks {
  const stepMs = Math.min(3000, Math.max(60, Number(process.env.AGENT_STEP_SECONDS) || 420)) * 1000;
  return {
    async load() {
      const status = await ctx.runQuery(internal.reviews.agentStatus, { reviewId });
      if (!status?.agentStateStorageId || status.agentStateHead !== status.headSha) return null;
      const stored = await ctx.storage.get(status.agentStateStorageId);
      if (!stored || stored.size > 8_000_000) return null;
      const parsed = agentStateSchema.safeParse(JSON.parse(await stored.text()));
      return parsed.success ? (parsed.data as AgentState) : null;
    },
    async save(state) {
      const storageId = await ctx.storage.store(new Blob([JSON.stringify(state)], { type: "application/json" }));
      if (!await ctx.runMutation(internal.reviews.saveAgentState, { reviewId, storageId, headSha: state.headSha })) throw new Error("Review is no longer active for this revision");
    },
    async checkpoint() {
      const status = await ctx.runQuery(internal.reviews.agentStatus, { reviewId });
      if (!status || status.status === "cancelled") throw new Error("Review cancelled");
    },
    shouldSuspend: () => Date.now() - stepStarted > stepMs,
  };
}
