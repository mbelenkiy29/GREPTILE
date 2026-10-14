import type { MutationCtx } from "./_generated/server";
export async function rateLimit(
  ctx: MutationCtx,
  key: string,
  maximum: number,
  windowMs = 60000,
) {
  const now = Date.now(),
    window = Math.floor(now / windowMs);
  const record = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (record && record.window === window) {
    if (record.count >= maximum)
      throw new Error("Rate limit exceeded; retry after the current window");
    await ctx.db.patch(record._id, { count: record.count + 1 });
  } else if (record) await ctx.db.patch(record._id, { window, count: 1 });
  else await ctx.db.insert("rateLimits", { key, window, count: 1 });
}
