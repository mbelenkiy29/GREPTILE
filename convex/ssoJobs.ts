"use node";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { verifyDomainTxt } from "../src/sso";

// Domain verification: an admin publishes the TXT record, then asks OpenReview to look it up.
export const verifyDomain = action({ args: { token: v.string(), domainId: v.id("ssoDomains") }, handler: async (ctx, a): Promise<boolean> => {
  const d = await ctx.runQuery(internal.sso.domainCheck, a);
  if (!(await verifyDomainTxt(d.domain, d.token))) return false;
  return ctx.runMutation(internal.sso.markVerified, { domainId: a.domainId });
} });
