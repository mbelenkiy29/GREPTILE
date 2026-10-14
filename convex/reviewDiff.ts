"use node";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { provider } from "./scm";

// The reviewed change for the diff viewer: the exact base...head comparison when the provider
// supports it, else the pull request's current diff when its head is still the reviewed one.
// Read on demand (never on auto-refresh) and bounded to 40 files / 400 KB of patch text.
export const load = action({ args: { token: v.string(), reviewId: v.id("reviews") }, handler: async (ctx, a): Promise<{ source: "compare" | "pull-request" | "unavailable"; revision: string; files: { path: string; status: string; patch: string; truncated: boolean }[]; omitted: number; reason?: string }> => {
  const detail = await ctx.runQuery(api.reviews.detail, { token: a.token, reviewId: a.reviewId });
  const review = detail.review;
  const { repo } = await ctx.runQuery(internal.repositories.data, { repositoryId: review.repositoryId });
  const scm = await provider(ctx, repo);
  let files: { path: string; status: string; patch: string }[] | null = null, source: "compare" | "pull-request" = "compare";
  if (review.baseSha && scm.compare) {
    const compared = await scm.compare(repo.fullName, review.baseSha, review.headSha).catch(() => null);
    if (compared) files = compared.files;
  }
  if (!files) {
    const pr = await scm.pullRequest(repo.fullName, review.prNumber);
    if (pr.head.sha !== review.headSha) return { source: "unavailable", revision: review.headSha, files: [], omitted: 0, reason: "The pull request has moved past the reviewed revision and this provider cannot compare revisions." };
    files = pr.diff; source = "pull-request";
  }
  const withFindings = new Set(detail.findings.map((f) => f.filePath));
  const ordered = [...files].sort((x, y) => Number(withFindings.has(y.path)) - Number(withFindings.has(x.path)));
  let budget = 400_000;
  const out = ordered.slice(0, 40).map((f) => { const patch = f.patch.slice(0, Math.max(0, Math.min(budget, 60_000))); budget -= patch.length; return { path: f.path, status: f.status, patch, truncated: patch.length < f.patch.length }; });
  return { source, revision: review.headSha, files: out, omitted: Math.max(0, files.length - out.length) };
} });
