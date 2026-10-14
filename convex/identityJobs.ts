"use node";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHash, randomBytes } from "node:crypto";
import { service } from "./auth";
import { emailAddress, emailConfigured, sendEmail } from "../src/email";

// Random single-use tokens are generated here (Node crypto); only their SHA-256 is stored.
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const token = () => { const raw = randomBytes(32).toString("base64url"); return { raw, hash: createHash("sha256").update(raw).digest("hex") }; };

export const inviteByEmail = action({ args: { token: v.string(), organizationId: v.id("organizations"), email: v.string(), role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")) }, handler: async (ctx, a): Promise<"sent" | "skipped"> => {
  if (!emailConfigured()) throw new Error("Email delivery is not configured (RESEND_API_KEY and EMAIL_FROM)");
  const t = token();
  const created = await ctx.runMutation(internal.identity.createEmailInvitation, { token: a.token, organizationId: a.organizationId, email: a.email, role: a.role, tokenHash: t.hash });
  const result = await sendEmail({ to: created.email, subject: `You're invited to ${created.workspace} on OpenReview`, text: `@${created.inviter} invited you to join ${created.workspace} on OpenReview as ${a.role}.\n\nAccept the invitation (single use, expires in 7 days):\n${appOrigin()}/invite?token=${t.raw}\n\nIf you were not expecting this, ignore this email.` });
  return "skipped" in result ? "skipped" : "sent";
} });

// Magic-link sign-in. The response never reveals whether an account exists for the address.
export const requestMagicLink = action({ args: { secret: v.string(), email: v.string(), next: v.optional(v.string()) }, handler: async (ctx, a): Promise<"sent"> => {
  service(a.secret);
  if (!emailConfigured()) throw new Error("Email sign-in is not configured");
  const email = emailAddress.parse(a.email), t = token();
  await ctx.runMutation(internal.identity.storeLoginToken, { email, tokenHash: t.hash });
  const next = a.next && /^\/(?!\/)[A-Za-z0-9/_?=&.%-]{0,300}$/.test(a.next) ? `&next=${encodeURIComponent(a.next)}` : "";
  await sendEmail({ to: email, subject: "Your OpenReview sign-in link", text: `Sign in to OpenReview (single use, expires in 15 minutes):\n${appOrigin()}/api/auth/email/verify?token=${t.raw}${next}\n\nIf you did not request this, ignore this email.` });
  return "sent";
} });
