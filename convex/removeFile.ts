import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
export async function removeFile(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
  path: string,
) {
  const file = await ctx.db
    .query("repositoryFiles")
    .withIndex("by_path", (q) =>
      q.eq("repositoryId", repositoryId).eq("path", path),
    )
    .unique();
  if (file) {
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(file._id);
  }
  const receipt=await ctx.db.query("graphModuleReferences").withIndex("by_path",q=>q.eq("repositoryId",repositoryId).eq("path",path)).unique();
  if(receipt)await ctx.db.delete(receipt._id);
  for (const chunk of await ctx.db
    .query("codeChunks")
    .withIndex("by_file", (q) =>
      q.eq("repositoryId", repositoryId).eq("filePath", path),
    )
    .collect())
    await ctx.db.delete(chunk._id);
  for (const symbol of await ctx.db
    .query("symbols")
    .withIndex("by_file", (q) =>
      q.eq("repositoryId", repositoryId).eq("filePath", path),
    )
    .collect())
    await ctx.db.delete(symbol._id);
  const edges = await ctx.db
    .query("relationships")
    .withIndex("by_source", (q) =>
      q.eq("repositoryId", repositoryId).eq("sourcePath", path),
    )
    .collect();
  for (const edge of edges) await ctx.db.delete(edge._id);
  const embedding = await ctx.db
    .query("embeddings")
    .withIndex("by_path", (q) =>
      q.eq("repositoryId", repositoryId).eq("path", path),
    )
    .unique();
  if (embedding) await ctx.db.delete(embedding._id);
}
