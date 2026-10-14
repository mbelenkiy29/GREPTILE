import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

// Action-side readers for the indexed file inventory. Each Convex query stays bounded
// (≤200 path lookups or one ≤1000-row page), so repositories of any size stay under
// per-transaction read limits.
export async function indexedFiles(ctx: ActionCtx, repositoryId: Id<"repositories">, paths: string[]) {
  const unique = [...new Set(paths)], out = [];
  for (let i = 0; i < unique.length; i += 200)
    out.push(...(await ctx.runQuery(internal.repositories.filesByPath, { repositoryId, paths: unique.slice(i, i + 200) })));
  return out;
}
export async function fileInventory(ctx: ActionCtx, repositoryId: Id<"repositories">) {
  const files = new Map<string, string>();
  let cursor: string | null = null;
  for (let pages = 0; pages < 10_000; pages++) {
    const page: { files: { path: string; sha: string }[]; cursor: string; done: boolean } = await ctx.runQuery(internal.repositories.filePage, { repositoryId, cursor });
    for (const file of page.files) files.set(file.path, file.sha);
    if (page.done) return files;
    cursor = page.cursor;
  }
  throw new Error("Indexed file inventory exceeds 10,000 pages");
}
