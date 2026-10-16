"use node";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHash, randomBytes } from "node:crypto";
import type { Id } from "./_generated/dataModel";
import { decryptCredential, encryptCredential } from "../src/credentials";
import { sendEmail } from "../src/email";
import { appliesTo, emailReview, slackReviewText, type NotificationEvent } from "../src/notifications";
import { SlackApi, escapeSlack, exchangeSlackCode, slackLink } from "../src/slack";
import { budgetModel } from "./budgetModel";
import { chatToolbox } from "./agentToolbox";
import { runChatAgent } from "../src/engine/chat";
import { repositorySourceUrl } from "../src/source-url";
import type { ModelUsage } from "../src/engine/types";
import { service } from "./auth";
import { egressAllowed } from "../src/egress";

const appOrigin = () => { try { return process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined; } catch { return undefined; } };
async function slackClient(ctx: ActionCtx, installationId: Id<"slackInstallations">) {
  if (!egressAllowed("slack")) return null;
  const install = await ctx.runQuery(internal.notifications.slackCredentials, { installationId });
  return install?.credentials ? new SlackApi(decryptCredential(install.credentials, `${install.organizationId}:slack`)) : null;
}
async function deliver(ctx: ActionCtx, organizationId: Id<"organizations">, key: string, channel: "slack" | "email", send: () => Promise<{ skipped?: string } | unknown>) {
  if (!await ctx.runMutation(internal.notifications.claimDelivery, { organizationId, key, channel })) return "duplicate";
  try {
    const result = await send() as { skipped?: string } | undefined;
    await ctx.runMutation(internal.notifications.deliveryResult, { key, status: result?.skipped ? "skipped" : "sent", ...(result?.skipped ? { error: result.skipped } : {}) });
    return result?.skipped ? "skipped" : "sent";
  } catch (error) {
    await ctx.runMutation(internal.notifications.deliveryResult, { key, status: "failed", error: error instanceof Error ? error.message : "Delivery failed" });
    return "failed";
  }
}

// Fan-out for a completed review: each (event, target) is delivered at most once.
export const reviewCompleted = internalAction({ args: { reviewId: v.id("reviews") }, handler: async (ctx, a): Promise<Record<string, string>> => {
  const targets = await ctx.runQuery(internal.notifications.reviewTargets, { reviewId: a.reviewId });
  if (!targets) return {};
  const origin = appOrigin(), notice = { ...targets.notice, ...(origin ? { reviewUrl: `${origin}/dashboard/pulls/${a.reviewId}` } : {}) };
  const outcome: Record<string, string> = {};
  const slack = targets.installationId && targets.channels.length ? await slackClient(ctx, targets.installationId) : null;
  for (const channel of targets.channels) for (const event of channel.events as NotificationEvent[]) {
    if (!appliesTo(event, notice) || !slack) continue;
    const key = `${event}:${a.reviewId}:slack:${channel.channelId}`;
    outcome[key] = await deliver(ctx, targets.organizationId, key, "slack", () => slack.postMessage({ channel: channel.channelId, text: slackReviewText(event, notice) }));
  }
  for (const recipient of targets.recipients) for (const event of recipient.events as NotificationEvent[]) {
    if (!appliesTo(event, notice)) continue;
    const key = `${event}:${a.reviewId}:email:${recipient.userId}`;
    outcome[key] = await deliver(ctx, targets.organizationId, key, "email", () => sendEmail({ to: recipient.email, ...emailReview(event, notice) }));
  }
  return outcome;
} });

// Email verification: a random token (only its hash is stored) mailed as a one-hour link.
export const sendVerification = internalAction({ args: { preferenceId: v.id("notificationPreferences") }, handler: async (ctx, a): Promise<string> => {
  const target = await ctx.runQuery(internal.notifications.verificationTarget, { preferenceId: a.preferenceId });
  const origin = appOrigin();
  if (!target || !origin) return "skipped";
  const token = randomBytes(32).toString("base64url");
  if (!await ctx.runMutation(internal.notifications.storeVerification, { preferenceId: a.preferenceId, email: target.email, hash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600_000 })) return "skipped";
  const result = await sendEmail({ to: target.email, subject: "Confirm your OpenReview notification email", text: `Confirm this address for OpenReview notifications:\n\n${origin}/api/notifications/verify?token=${token}\n\nThe link expires in one hour. If you did not request it, ignore this email.` });
  return "skipped" in result ? "skipped" : "sent";
} });

export const slackReply = internalAction({ args: { installationId: v.id("slackInstallations"), channelId: v.string(), threadTs: v.string(), text: v.string() }, handler: async (ctx, a): Promise<void> => {
  const slack = await slackClient(ctx, a.installationId);
  await slack?.postMessage({ channel: a.channelId, threadTs: a.threadTs, text: a.text });
} });

// Slack Q&A in the thread: the codebase-chat engine over the channel's linked repositories,
// read with the installing admin's access; usage is recorded and the inference budget applies.
export const slackAnswer = internalAction({ args: { installationId: v.id("slackInstallations"), channelId: v.string(), threadTs: v.string(), question: v.string(), repositoryIds: v.array(v.id("repositories")) }, handler: async (ctx, a): Promise<string> => {
  const slack = await slackClient(ctx, a.installationId);
  const context = await ctx.runQuery(internal.notifications.answerContext, { installationId: a.installationId, repositoryIds: a.repositoryIds });
  if (!slack || !context) return "not installed";
  if (!context.repositories.length) { await slack.postMessage({ channel: a.channelId, threadTs: a.threadTs, text: "None of this channel's linked repositories are indexed and accessible right now." }); return "no repositories"; }
  const placeholder = await slack.postMessage({ channel: a.channelId, threadTs: a.threadTs, text: `Investigating ${context.repositories.map((r) => r.repo.fullName).join(", ")}…` });
  const usage: ModelUsage[] = [];
  let text: string, outcome = "answered";
  try {
    const run = await runChatAgent({ question: a.question, history: [], repositories: context.repositories.map(({ repo }) => ({ name: repo.fullName, tools: chatToolbox(ctx, repo) })), model: budgetModel(ctx), usage });
    if (run.answer) {
      const sources = run.answer.citations.map((c, i) => {
        const entry = context.repositories.find((r) => r.repo.fullName === c.repository)!;
        let url: string | undefined;
        try { url = entry.source ? repositorySourceUrl(entry.source.kind, entry.source.instance, entry.repo.fullName, c.revision, c.filePath, entry.repo.externalId) + (entry.source.kind.startsWith("github") ? `#L${c.startLine}${c.endLine > c.startLine ? "-L" + c.endLine : ""}` : "") : undefined; } catch { url = undefined; }
        const label = `${c.repository}:${c.filePath}:${c.startLine}${c.endLine > c.startLine ? "-" + c.endLine : ""}`;
        return `[${i + 1}] ${url ? slackLink(url, label) : escapeSlack(label)}`;
      });
      text = `${escapeSlack(run.answer.text)}\n\n${sources.join("\n")}`;
    } else { text = "I could not produce an answer whose citations match the indexed code. Try a narrower question."; outcome = "no answer"; }
  } catch { text = "OpenReview could not answer right now (the inference budget or model may be unavailable)."; outcome = "failed"; }
  if (usage.length) await ctx.runMutation(internal.usage.record, { repositoryId: context.repositories[0].repo._id, kind: "slack", inputTokens: usage.reduce((t, u) => t + u.inputTokens, 0), outputTokens: usage.reduce((t, u) => t + u.outputTokens, 0), estimatedCost: usage.reduce((t, u) => t + u.estimatedCost, 0), durationMs: usage.reduce((t, u) => t + u.latencyMs, 0) });
  await slack.updateMessage({ channel: a.channelId, ts: placeholder.ts, text });
  return outcome;
} });

// OAuth completion (called by the Next.js callback with the admin's session and the service secret).
export const installSlack = action({ args: { token: v.string(), secret: v.string(), organizationId: v.id("organizations"), code: v.string(), redirectUri: v.string(), jti: v.string(), expiresAt: v.number() }, handler: async (ctx, a): Promise<Id<"slackInstallations">> => {
  service(a.secret);
  const clientId = process.env.SLACK_CLIENT_ID, clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Configure SLACK_CLIENT_ID and SLACK_CLIENT_SECRET");
  await ctx.runMutation(internal.notifications.slackReceipt, { token: a.token, organizationId: a.organizationId, jti: a.jti, expiresAt: a.expiresAt });
  const granted = await exchangeSlackCode({ clientId, clientSecret, code: a.code, redirectUri: a.redirectUri });
  return ctx.runMutation(internal.notifications.saveSlackInstallation, { token: a.token, organizationId: a.organizationId, teamId: granted.teamId, teamName: granted.teamName, botUserId: granted.botUserId, credentials: encryptCredential(granted.token, `${a.organizationId}:slack`) });
} });
