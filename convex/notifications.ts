import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { audit, authorize, repositoryAccess } from "./auth";
import { rateLimit } from "./rateLimit";
import { emailAddress } from "../src/email";
import { notificationEvents } from "../src/notifications";
import { mentionQuestion, slackChannelId } from "../src/slack";

// Notifications: Slack channels (admin-linked) and per-member email. Everything is inert until a
// Slack workspace is installed or a member verifies an email address.
const level = v.union(v.literal("off"), v.literal("mine"), v.literal("all"));
const preferenceDefaults = { reviewCompleted: "off", highSeverity: "off" };
async function ownPreferences(ctx: QueryCtx, userId: Id<"users">, organizationId: Id<"organizations">) {
  return ctx.db.query("notificationPreferences").withIndex("by_user_org", (q) => q.eq("userId", userId).eq("organizationId", organizationId)).unique();
}
const activeSlack = (ctx: QueryCtx, organizationId: Id<"organizations">) => ctx.db.query("slackInstallations").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).filter((q) => q.eq(q.field("active"), true)).first();

export const settings = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user, member } = await authorize(ctx, a.token, a.organizationId);
  const admin = ["owner", "admin"].includes(member.role);
  const slack = await activeSlack(ctx, a.organizationId);
  const own = await ownPreferences(ctx, user._id, a.organizationId);
  const channels = admin && slack ? await ctx.db.query("notificationChannels").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).filter((q) => q.eq(q.field("installationId"), slack._id)).take(200) : [];
  return {
    admin,
    slackConfigured: Boolean(process.env.SLACK_CLIENT_ID),
    emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    slack: slack ? { teamId: slack.teamId, teamName: slack.teamName, installedAt: slack.createdAt } : null,
    channels: channels.map((c) => ({ _id: c._id, channelId: c.channelId, repositoryIds: c.repositoryIds, events: c.events, qa: c.qa })),
    preferences: { email: own?.email ?? null, verified: Boolean(own?.emailVerifiedAt), reviewCompleted: own?.reviewCompleted ?? preferenceDefaults.reviewCompleted, highSeverity: own?.highSeverity ?? preferenceDefaults.highSeverity },
  };
} });

export const saveChannel = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), channelId: v.string(), repositoryIds: v.array(v.id("repositories")), events: v.array(v.string()), qa: v.boolean() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const slack = await activeSlack(ctx, a.organizationId);
  if (!slack) throw new Error("Install the Slack app first");
  const channelId = slackChannelId.parse(a.channelId.trim());
  const repositoryIds = [...new Set(a.repositoryIds)];
  for (const id of repositoryIds) { const repo = await ctx.db.get(id); if (!repo || repo.organizationId !== a.organizationId) throw new Error("Repository not accessible"); }
  const events = [...new Set(a.events)];
  if (events.some((e) => !(notificationEvents as readonly string[]).includes(e))) throw new Error("Unknown notification event");
  if (a.qa && (!repositoryIds.length || repositoryIds.length > 5)) throw new Error("Q&A needs 1 to 5 linked repositories");
  const existing = await ctx.db.query("notificationChannels").withIndex("by_channel", (q) => q.eq("installationId", slack._id).eq("channelId", channelId)).unique();
  const data = { repositoryIds, events, qa: a.qa };
  const id = existing ? existing._id : await ctx.db.insert("notificationChannels", { organizationId: a.organizationId, installationId: slack._id, channelId, ...data, createdBy: user._id, createdAt: Date.now() });
  if (existing) await ctx.db.patch(id, data);
  await audit(ctx, a.organizationId, user._id, "notification_channel.saved", id);
  return id;
} });
export const removeChannel = mutation({ args: { token: v.string(), channelId: v.id("notificationChannels") }, handler: async (ctx, a) => {
  const channel = await ctx.db.get(a.channelId);
  if (!channel) throw new Error("Channel not found");
  const { user } = await authorize(ctx, a.token, channel.organizationId, true);
  await ctx.db.delete(channel._id);
  await audit(ctx, channel.organizationId, user._id, "notification_channel.removed", channel._id);
} });
export const disconnectSlack = mutation({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const slack = await activeSlack(ctx, a.organizationId);
  if (!slack) return;
  await ctx.db.patch(slack._id, { active: false, credentials: "", updatedAt: Date.now() });
  for (const c of await ctx.db.query("notificationChannels").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(500)) if (c.installationId === slack._id) await ctx.db.delete(c._id);
  await audit(ctx, a.organizationId, user._id, "slack.disconnected", slack._id);
} });

export const savePreferences = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), reviewCompleted: level, highSeverity: level }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  const own = await ownPreferences(ctx, user._id, a.organizationId);
  const data = { reviewCompleted: a.reviewCompleted, highSeverity: a.highSeverity, updatedAt: Date.now() };
  if (own) await ctx.db.patch(own._id, data); else await ctx.db.insert("notificationPreferences", { organizationId: a.organizationId, userId: user._id, ...data });
} });
// Setting an address sends a verification link; nothing is emailed until it is confirmed.
export const setEmail = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), email: v.string() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  const email = emailAddress.parse(a.email);
  await rateLimit(ctx, `email-verify:${user._id}`, 3);
  const own = await ownPreferences(ctx, user._id, a.organizationId);
  const data = { email, emailVerifiedAt: undefined, verificationHash: undefined, verificationExpiresAt: undefined, updatedAt: Date.now() };
  const id = own ? own._id : await ctx.db.insert("notificationPreferences", { organizationId: a.organizationId, userId: user._id, ...preferenceDefaults, ...data });
  if (own) await ctx.db.patch(id, data);
  await ctx.scheduler.runAfter(0, internal.notificationJobs.sendVerification, { preferenceId: id });
} });
export const verifyEmail = mutation({ args: { tokenHash: v.string() }, handler: async (ctx, a) => {
  if (!/^[a-f0-9]{64}$/.test(a.tokenHash)) return false;
  const p = await ctx.db.query("notificationPreferences").withIndex("by_verification", (q) => q.eq("verificationHash", a.tokenHash)).unique();
  if (!p || !p.verificationExpiresAt || p.verificationExpiresAt < Date.now()) return false;
  await ctx.db.patch(p._id, { emailVerifiedAt: Date.now(), verificationHash: undefined, verificationExpiresAt: undefined, updatedAt: Date.now() });
  return true;
} });
export const verificationTarget = internalQuery({ args: { preferenceId: v.id("notificationPreferences") }, handler: async (ctx, a) => {
  const p = await ctx.db.get(a.preferenceId);
  return p?.email && !p.emailVerifiedAt ? { email: p.email } : null;
} });
export const storeVerification = internalMutation({ args: { preferenceId: v.id("notificationPreferences"), email: v.string(), hash: v.string(), expiresAt: v.number() }, handler: async (ctx, a) => {
  const p = await ctx.db.get(a.preferenceId);
  if (!p || p.email !== a.email || p.emailVerifiedAt) return false;
  await ctx.db.patch(p._id, { verificationHash: a.hash, verificationExpiresAt: a.expiresAt });
  return true;
} });

// Whether a completed review in this workspace could notify anyone (avoids scheduling no-op jobs).
export async function notificationsEnabled(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return Boolean(await activeSlack(ctx, organizationId)) || Boolean(await ctx.db.query("notificationPreferences").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).filter((q) => q.neq(q.field("emailVerifiedAt"), undefined)).first());
}
// Fan-out targets for a completed review: linked Slack channels and verified, opted-in members
// who can read the repository ("mine" = the pull request's author).
export const reviewTargets = internalQuery({ args: { reviewId: v.id("reviews") }, handler: async (ctx, a) => {
  const review = await ctx.db.get(a.reviewId);
  if (!review || review.status !== "completed") return null;
  const repo = await ctx.db.get(review.repositoryId);
  if (!repo) return null;
  const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", repo._id).eq("number", review.prNumber)).first();
  const findings = (await ctx.db.query("reviewFindings").withIndex("by_review", (q) => q.eq("reviewId", review._id)).take(200)).map((f) => ({ title: f.snapshot.title, severity: f.snapshot.severity, category: f.snapshot.category, filePath: f.snapshot.filePath, startLine: f.snapshot.startLine }));
  const slack = await activeSlack(ctx, repo.organizationId);
  const channels = slack ? (await ctx.db.query("notificationChannels").withIndex("by_org", (q) => q.eq("organizationId", repo.organizationId)).take(500)).filter((c) => c.installationId === slack._id && (!c.repositoryIds.length || c.repositoryIds.includes(repo._id))).map((c) => ({ channelId: c.channelId, events: c.events })) : [];
  const recipients: { userId: Id<"users">; email: string; events: string[] }[] = [];
  for (const p of await ctx.db.query("notificationPreferences").withIndex("by_org", (q) => q.eq("organizationId", repo.organizationId)).take(1000)) {
    if (!p.email || !p.emailVerifiedAt) continue;
    const user = await ctx.db.get(p.userId);
    try { await repositoryAccess(ctx, p.userId, repo._id); } catch { continue; }
    const mine = Boolean(user && pr && user.login.toLowerCase() === pr.author.toLowerCase());
    const events = ([["review.completed", p.reviewCompleted], ["finding.high", p.highSeverity]] as const).filter(([, l]) => l === "all" || (l === "mine" && mine)).map(([e]) => e);
    if (events.length) recipients.push({ userId: p.userId, email: p.email, events });
  }
  return { organizationId: repo.organizationId, installationId: slack?._id ?? null, notice: { repository: repo.fullName, prNumber: review.prNumber, prTitle: pr?.title, prUrl: pr?.url, headSha: review.headSha, findings }, channels, recipients };
} });
// Claims a delivery once; a failed delivery may be retried, a sent or skipped one never repeats.
export const claimDelivery = internalMutation({ args: { organizationId: v.id("organizations"), key: v.string(), channel: v.string() }, handler: async (ctx, a) => {
  const existing = await ctx.db.query("notificationDeliveries").withIndex("by_key", (q) => q.eq("key", a.key)).unique();
  if (existing && existing.status !== "failed") return false;
  if (existing) await ctx.db.patch(existing._id, { status: "sending", error: undefined, updatedAt: Date.now() });
  else await ctx.db.insert("notificationDeliveries", { organizationId: a.organizationId, key: a.key, channel: a.channel, status: "sending", createdAt: Date.now(), updatedAt: Date.now() });
  return true;
} });
export const deliveryResult = internalMutation({ args: { key: v.string(), status: v.string(), error: v.optional(v.string()) }, handler: async (ctx, a) => {
  const d = await ctx.db.query("notificationDeliveries").withIndex("by_key", (q) => q.eq("key", a.key)).unique();
  if (d) await ctx.db.patch(d._id, { status: a.status, error: a.error?.slice(0, 300), updatedAt: Date.now() });
} });

// Slack install: one-time OAuth state, then an upsert keyed by Slack workspace.
export const slackReceipt = internalMutation({ args: { token: v.string(), organizationId: v.id("organizations"), jti: v.string(), expiresAt: v.number() }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  if (!/^slack:[a-zA-Z0-9_-]{32,128}$/.test(a.jti) || a.expiresAt <= Date.now() || a.expiresAt > Date.now() + 600000) throw new Error("Invalid Slack OAuth state");
  if (await ctx.db.query("providerReceipts").withIndex("by_jti", (q) => q.eq("jti", a.jti)).unique()) throw new Error("OAuth state already used");
  const id = await ctx.db.insert("providerReceipts", { jti: a.jti, expiresAt: a.expiresAt });
  await ctx.scheduler.runAt(a.expiresAt, internal.providerConnections.expireReceipt, { id });
} });
export const saveSlackInstallation = internalMutation({ args: { token: v.string(), organizationId: v.id("organizations"), teamId: v.string(), teamName: v.string(), botUserId: v.string(), credentials: v.string() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const existing = await ctx.db.query("slackInstallations").withIndex("by_team", (q) => q.eq("teamId", a.teamId)).first();
  if (existing?.active && existing.organizationId !== a.organizationId) throw new Error("This Slack workspace is connected to another OpenReview workspace");
  const current = await activeSlack(ctx, a.organizationId);
  if (current && current.teamId !== a.teamId) throw new Error("Disconnect the current Slack workspace first");
  const data = { teamName: a.teamName.slice(0, 200), botUserId: a.botUserId, credentials: a.credentials, installedBy: user._id, active: true, updatedAt: Date.now() };
  const id = existing ? existing._id : await ctx.db.insert("slackInstallations", { organizationId: a.organizationId, teamId: a.teamId, ...data, createdAt: Date.now() });
  if (existing) await ctx.db.patch(id, { organizationId: a.organizationId, ...data });
  await audit(ctx, a.organizationId, user._id, "slack.installed", id);
  return id;
} });
export const slackCredentials = internalQuery({ args: { installationId: v.id("slackInstallations") }, handler: async (ctx, a) => {
  const s = await ctx.db.get(a.installationId);
  return s?.active ? { organizationId: s.organizationId, credentials: s.credentials } : null;
} });

// Slack events: deduplicated by event ID, routed only for active installs, rate limited per team.
export const enqueueMention = internalMutation({ args: { eventId: v.string(), teamId: v.string(), channelId: v.string(), text: v.string(), ts: v.string(), threadTs: v.optional(v.string()) }, handler: async (ctx, a): Promise<string> => {
  if (await ctx.db.query("slackEventReceipts").withIndex("by_event", (q) => q.eq("eventId", a.eventId)).unique()) return "duplicate";
  await ctx.db.insert("slackEventReceipts", { eventId: a.eventId, createdAt: Date.now() });
  const installation = await ctx.db.query("slackInstallations").withIndex("by_team", (q) => q.eq("teamId", a.teamId)).first();
  if (!installation?.active) return "not installed";
  const channel = await ctx.db.query("notificationChannels").withIndex("by_channel", (q) => q.eq("installationId", installation._id).eq("channelId", a.channelId)).unique();
  const question = mentionQuestion(a.text, installation.botUserId);
  const threadTs = a.threadTs ?? a.ts;
  if (!channel?.qa || !channel.repositoryIds.length) { await ctx.scheduler.runAfter(0, internal.notificationJobs.slackReply, { installationId: installation._id, channelId: a.channelId, threadTs, text: "No repositories are linked to this channel for questions. A workspace admin can link up to five in OpenReview → Settings → Notifications." }); return "unlinked"; }
  if (question.length < 2) { await ctx.scheduler.runAfter(0, internal.notificationJobs.slackReply, { installationId: installation._id, channelId: a.channelId, threadTs, text: "Ask me a question about the linked repositories, for example: @OpenReview where is the checkout total computed?" }); return "help"; }
  try { await rateLimit(ctx, `slack:${a.teamId}`, 20); } catch { return "rate limited"; }
  await ctx.scheduler.runAfter(0, internal.notificationJobs.slackAnswer, { installationId: installation._id, channelId: a.channelId, threadTs, question, repositoryIds: channel.repositoryIds });
  return "queued";
} });
// Q&A context: linked repositories the installing admin can still read, with provider link data.
export const answerContext = internalQuery({ args: { installationId: v.id("slackInstallations"), repositoryIds: v.array(v.id("repositories")) }, handler: async (ctx, a) => {
  const installation = await ctx.db.get(a.installationId);
  if (!installation?.active) return null;
  const repositories: { repo: Doc<"repositories">; source?: { kind: string; instance: string } }[] = [];
  for (const id of a.repositoryIds.slice(0, 5)) {
    try {
      const { repo } = await repositoryAccess(ctx, installation.installedBy, id);
      if (repo.organizationId !== installation.organizationId || !repo.indexedSha) continue;
      const connection = repo.connectionId ? await ctx.db.get(repo.connectionId) : null;
      repositories.push({ repo, source: connection?.organizationId === repo.organizationId ? { kind: connection.kind, instance: connection.instance } : repo.connectionId ? undefined : { kind: "github", instance: "https://github.com" } });
    } catch { /* access revoked */ }
  }
  return { organizationId: installation.organizationId, repositories };
} });
// `/openreview status` (ephemeral): linked repositories and their index state for this channel.
export const commandStatus = internalQuery({ args: { teamId: v.string(), channelId: v.string(), text: v.string() }, handler: async (ctx, a) => {
  const installation = await ctx.db.query("slackInstallations").withIndex("by_team", (q) => q.eq("teamId", a.teamId)).first();
  if (!installation?.active) return "OpenReview is not connected to this Slack workspace.";
  const command = a.text.trim().toLowerCase();
  if (command && command !== "status") return "Usage: `/openreview status` shows the repositories linked to this channel. Mention @OpenReview with a question to ask about their code.";
  const channel = await ctx.db.query("notificationChannels").withIndex("by_channel", (q) => q.eq("installationId", installation._id).eq("channelId", a.channelId)).unique();
  if (!channel) return "This channel is not linked to OpenReview. A workspace admin can link it in OpenReview → Settings → Notifications.";
  const lines = [`Notifications: ${channel.events.length ? channel.events.join(", ") : "none"} · Q&A: ${channel.qa ? "on" : "off"}`];
  const ids = channel.repositoryIds.length ? channel.repositoryIds : [];
  for (const id of ids.slice(0, 10)) {
    const repo = await ctx.db.get(id);
    if (!repo || repo.organizationId !== installation.organizationId) continue;
    const last = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id)).order("desc").first();
    lines.push(`• ${repo.fullName}: ${repo.enabled ? `index ${repo.indexStatus}${repo.indexedSha ? ` @ ${repo.indexedSha.slice(0, 7)}` : ""}` : "disabled"}${last ? ` · last review #${last.prNumber} ${last.status}` : ""}`);
  }
  if (!ids.length) lines.push("• All repositories (notifications only)");
  return lines.join("\n");
} });
