import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authenticated } from "./auth";

// Per-user agent credentials (opt-in handoff targets). Only the owner can set, read or remove them; the
// stored value is ciphertext produced by the web server, and status queries never return it.
const kind = v.literal("devin");
export const status = query({ args: { token: v.string() }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token);
  const row = await ctx.db.query("personalCredentials").withIndex("by_user_kind", (q) => q.eq("userId", user._id).eq("kind", "devin")).unique();
  return { userId: user._id, devin: row ? { configured: true, updatedAt: row.updatedAt } : { configured: false } };
} });
// Ciphertext for the web server to decrypt when the user sends a finding to Devin.
export const ciphertext = query({ args: { token: v.string(), kind }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token);
  return (await ctx.db.query("personalCredentials").withIndex("by_user_kind", (q) => q.eq("userId", user._id).eq("kind", a.kind)).unique())?.ciphertext ?? null;
} });
export const set = mutation({ args: { token: v.string(), kind, ciphertext: v.optional(v.string()) }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token);
  const row = await ctx.db.query("personalCredentials").withIndex("by_user_kind", (q) => q.eq("userId", user._id).eq("kind", a.kind)).unique();
  if (a.ciphertext === undefined) { if (row) await ctx.db.delete(row._id); return; }
  if (a.ciphertext.split(".").length !== 3 || a.ciphertext.length > 2000) throw new Error("Invalid credential");
  if (row) await ctx.db.patch(row._id, { ciphertext: a.ciphertext, updatedAt: Date.now() });
  else await ctx.db.insert("personalCredentials", { userId: user._id, kind: a.kind, ciphertext: a.ciphertext, updatedAt: Date.now() });
} });
