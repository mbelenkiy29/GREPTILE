import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { authorize, repositoryAccess, visibleRepositories } from "./auth";
import { rateLimit } from "./rateLimit";

// Codebase chat over indexed repositories. A thread belongs to the member who started it; every
// read re-checks organization membership and repository visibility, and answers that used a
// repository the member can no longer see are withheld.
const maxRepositories = 5;
async function ownThread(ctx: QueryCtx | MutationCtx, token: string, threadId: Id<"chatThreads">) {
  const thread = await ctx.db.get(threadId);
  if (!thread) throw new Error("Thread not found");
  const identity = await authorize(ctx, token, thread.organizationId);
  if (thread.userId !== identity.user._id) throw new Error("Thread not found");
  return { thread, ...identity };
}
async function readable(ctx: QueryCtx | MutationCtx, userId: Id<"users">, ids: Id<"repositories">[]) {
  const out = new Set<Id<"repositories">>();
  for (const id of new Set(ids)) { try { await repositoryAccess(ctx, userId, id); out.add(id); } catch { /* not visible */ } }
  return out;
}
const withheld = "Hidden: this answer used a repository you can no longer access.";
function present(m: Doc<"chatMessages">, visible: Set<Id<"repositories">>) {
  const hidden = m.role === "assistant" && m.repositoryIds.some((id) => !visible.has(id));
  return { _id: m._id, role: m.role, status: m.status, createdAt: m.createdAt, content: hidden ? withheld : m.content, citations: hidden ? [] : m.citations ?? [], events: hidden ? [] : m.events ?? [], limits: hidden ? [] : m.limits ?? [], error: m.error, repositoryIds: m.repositoryIds };
}

export const threads = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  return (await ctx.db.query("chatThreads").withIndex("by_org_user", (q) => q.eq("organizationId", a.organizationId).eq("userId", user._id)).order("desc").take(50)).map((t) => ({ _id: t._id, title: t.title, updatedAt: t.updatedAt, repositoryIds: t.repositoryIds, origin: t.origin ?? "web" }));
} });

export const thread = query({ args: { token: v.string(), threadId: v.id("chatThreads") }, handler: async (ctx, a) => {
  const { thread, user } = await ownThread(ctx, a.token, a.threadId);
  const messages = await ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", thread._id)).take(200);
  const visible = await readable(ctx, user._id, messages.flatMap((m) => m.repositoryIds));
  return { _id: thread._id, title: thread.title, repositoryIds: thread.repositoryIds.filter((id) => visible.has(id)), messages: messages.map((m) => present(m, visible)) };
} });

// Polled by the SSE route: progress events while running, then the validated answer.
export const progress = query({ args: { token: v.string(), messageId: v.id("chatMessages") }, handler: async (ctx, a) => {
  const message = await ctx.db.get(a.messageId);
  if (!message) throw new Error("Message not found");
  const { user } = await ownThread(ctx, a.token, message.threadId);
  return present(message, await readable(ctx, user._id, message.repositoryIds));
} });

// The thread of a message, for API callers holding only the message ID.
export const threadOf = query({ args: { token: v.string(), messageId: v.id("chatMessages"), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const message = await ctx.db.get(a.messageId);
  if (!message || message.organizationId !== a.organizationId) throw new Error("Message not found");
  const { thread } = await ownThread(ctx, a.token, message.threadId);
  return thread._id;
} });

export const ask = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), threadId: v.optional(v.id("chatThreads")), repositoryIds: v.array(v.id("repositories")), question: v.string(), origin: v.optional(v.literal("api")) }, handler: async (ctx, a): Promise<{ threadId: Id<"chatThreads">; messageId: Id<"chatMessages"> }> => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  const question = a.question.trim();
  if (question.length < 2 || question.length > 4000) throw new Error("Ask a question of 2 to 4,000 characters");
  const ids = [...new Set(a.repositoryIds)];
  if (!ids.length || ids.length > maxRepositories) throw new Error(`Select 1 to ${maxRepositories} repositories`);
  const visible = await visibleRepositories(ctx, a.token, a.organizationId);
  for (const id of ids) {
    const repo = visible.find((r) => r._id === id);
    if (!repo) throw new Error("Repository not accessible");
    if (!repo.indexedSha) throw new Error(`${repo.fullName} has not been indexed yet`);
  }
  await rateLimit(ctx, `chat:${a.organizationId}`, 30);
  await rateLimit(ctx, `chat-user:${user._id}`, 6);
  const now = Date.now();
  let threadId = a.threadId;
  if (threadId) {
    const { thread } = await ownThread(ctx, a.token, threadId);
    if (thread.organizationId !== a.organizationId) throw new Error("Thread not found");
    const last = await ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", thread._id)).order("desc").first();
    if (last && (last.status === "pending" || last.status === "running")) throw new Error("Wait for the current answer to finish");
    await ctx.db.patch(thread._id, { repositoryIds: ids, updatedAt: now });
  } else threadId = await ctx.db.insert("chatThreads", { organizationId: a.organizationId, userId: user._id, title: question.replace(/\s+/g, " ").slice(0, 80), repositoryIds: ids, ...(a.origin ? { origin: a.origin } : {}), createdAt: now, updatedAt: now });
  await ctx.db.insert("chatMessages", { organizationId: a.organizationId, threadId, userId: user._id, role: "user", content: question, status: "completed", repositoryIds: ids, createdAt: now, updatedAt: now });
  const messageId = await ctx.db.insert("chatMessages", { organizationId: a.organizationId, threadId, userId: user._id, role: "assistant", content: "", status: "pending", repositoryIds: ids, events: [], createdAt: now, updatedAt: now });
  await ctx.scheduler.runAfter(0, internal.chatJobs.answer, { messageId });
  return { threadId, messageId };
} });

export const deleteThread = mutation({ args: { token: v.string(), threadId: v.id("chatThreads") }, handler: async (ctx, a) => {
  const { thread } = await ownThread(ctx, a.token, a.threadId);
  for (const m of await ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", thread._id)).take(500)) await ctx.db.delete(m._id);
  await ctx.db.delete(thread._id);
} });

// Job inputs: the asking member must still see every selected repository.
export const job = internalQuery({ args: { messageId: v.id("chatMessages") }, handler: async (ctx, a) => {
  const message = await ctx.db.get(a.messageId);
  if (!message || message.role !== "assistant" || message.status !== "pending") return null;
  const repositories = [];
  for (const id of message.repositoryIds) {
    const { repo } = await repositoryAccess(ctx, message.userId, id);
    if (repo.organizationId !== message.organizationId || !repo.indexedSha) throw new Error("Repository not available for chat");
    const connection = repo.connectionId ? await ctx.db.get(repo.connectionId) : null;
    const source = connection?.organizationId === repo.organizationId ? { kind: connection.kind, instance: connection.instance } : repo.connectionId ? undefined : { kind: "github", instance: "https://github.com" };
    repositories.push({ repo, source });
  }
  const earlier = (await ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", message.threadId)).take(200)).filter((m) => m._creationTime < message._creationTime && m.status === "completed");
  const question = earlier.filter((m) => m.role === "user").at(-1)?.content ?? "";
  return { message, repositories, question, history: earlier.slice(0, -1).slice(-8).map((m) => ({ role: m.role === "user" ? "user" as const : "assistant" as const, content: m.content })) };
} });
export const start = internalMutation({ args: { messageId: v.id("chatMessages") }, handler: async (ctx, a) => {
  const m = await ctx.db.get(a.messageId);
  if (!m || m.status !== "pending") return false;
  await ctx.db.patch(m._id, { status: "running", updatedAt: Date.now() });
  return true;
} });
export const event = internalMutation({ args: { messageId: v.id("chatMessages"), kind: v.string(), text: v.string() }, handler: async (ctx, a) => {
  const m = await ctx.db.get(a.messageId);
  if (!m || m.status !== "running") return;
  await ctx.db.patch(m._id, { events: [...(m.events ?? []), { at: Date.now(), kind: a.kind.slice(0, 20), text: a.text.slice(0, 200) }].slice(-40), updatedAt: Date.now() });
} });
export const complete = internalMutation({ args: { messageId: v.id("chatMessages"), content: v.string(), citations: v.array(v.object({ repositoryId: v.id("repositories"), repository: v.string(), filePath: v.string(), startLine: v.number(), endLine: v.number(), quote: v.string(), revision: v.string(), url: v.optional(v.string()) })), limits: v.array(v.string()), inputTokens: v.number(), outputTokens: v.number(), estimatedCost: v.number() }, handler: async (ctx, a) => {
  const m = await ctx.db.get(a.messageId);
  if (!m || m.status !== "running") return;
  if (a.citations.some((c) => !m.repositoryIds.includes(c.repositoryId))) throw new Error("Citation outside the selected repositories");
  await ctx.db.patch(m._id, { status: "completed", content: a.content.slice(0, 12000), citations: a.citations.slice(0, 12), limits: a.limits.slice(0, 5), inputTokens: a.inputTokens, outputTokens: a.outputTokens, estimatedCost: a.estimatedCost, updatedAt: Date.now() });
  await ctx.db.patch(m.threadId, { updatedAt: Date.now() });
} });
export const fail = internalMutation({ args: { messageId: v.id("chatMessages"), error: v.string(), limits: v.optional(v.array(v.string())) }, handler: async (ctx, a) => {
  const m = await ctx.db.get(a.messageId);
  if (!m || m.status === "completed") return;
  await ctx.db.patch(m._id, { status: "failed", error: a.error.slice(0, 500), limits: (a.limits ?? []).slice(0, 5), updatedAt: Date.now() });
} });
