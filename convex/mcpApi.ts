import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { authorize, visibleRepositories } from "./auth";
import { contextReadable } from "./repositoryContext";
import { priorityOf } from "../src/priority";

// Read models behind the MCP tools get_review_status, report (pr_status) and list_unresolved_comments.
// Same access rules as the dashboard: visible repositories only, and reviews whose cross-repository
// context the reader may see.

// Latest review of one pull request, whether it covers the current head, and its open findings.
export const prStatus = query({ args: { token: v.string(), organizationId: v.id("organizations"), repositoryId: v.id("repositories"), prNumber: v.number() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  const repo = (await visibleRepositories(ctx, a.token, a.organizationId)).find((r) => r._id === a.repositoryId);
  if (!repo) throw new Error("Repository not accessible");
  const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", repo._id).eq("number", a.prNumber)).unique();
  const reviews = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", a.prNumber)).order("desc").take(20);
  let latest: Doc<"reviews"> | undefined;
  for (const r of reviews) if (await contextReadable(ctx, user._id, r)) { latest = r; break; }
  const open = latest ? (await ctx.db.query("findings").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", a.prNumber)).take(500)).filter((f) => f.status === "open") : [];
  return {
    repository: repo.fullName, prNumber: a.prNumber,
    pullRequest: pr ? { title: pr.title, state: pr.state, author: pr.author, headSha: pr.headSha, url: pr.url } : null,
    review: latest ? { reviewId: latest._id, status: latest.status, verdict: latest.verdict ?? null, headSha: latest.headSha, coversCurrentHead: pr ? latest.headSha === pr.headSha : null, findingCount: latest.findingCount ?? 0, reviewScore: latest.reviewScore ?? null, updatedAt: latest.updatedAt } : null,
    unresolved: open.length,
  };
} });

// Open findings on the caller's own open pull requests (matched by their provider login).
export const unresolvedForUser = query({ args: { token: v.string(), organizationId: v.id("organizations"), repositoryId: v.optional(v.id("repositories")) }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  const repos = await visibleRepositories(ctx, a.token, a.organizationId);
  if (a.repositoryId && !repos.some((r) => r._id === a.repositoryId)) throw new Error("Repository not accessible");
  const names = new Map(repos.filter((r) => !a.repositoryId || r._id === a.repositoryId).map((r) => [r._id as string, r.fullName]));
  const prs = (await ctx.db.query("pullRequests").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).order("desc").take(1000))
    .filter((p) => p.state === "open" && p.author.toLowerCase() === user.login.toLowerCase() && names.has(p.repositoryId)).slice(0, 50);
  const out = [];
  for (const pr of prs) {
    const findings = (await ctx.db.query("findings").withIndex("by_pr", (q) => q.eq("repositoryId", pr.repositoryId).eq("prNumber", pr.number)).take(200)).filter((f) => f.status === "open");
    for (const f of findings) {
      const review = await ctx.db.get(f.reviewId);
      if (!review || !(await contextReadable(ctx, user._id, review))) continue;
      out.push({ findingId: f._id, reviewId: f.reviewId, repository: names.get(pr.repositoryId)!, prNumber: pr.number, pullRequest: pr.title, title: f.title, severity: f.severity, priority: priorityOf(f.severity), category: f.category, filePath: f.filePath, line: f.startLine, suggestedFix: f.suggestedFix });
    }
  }
  return { login: user.login, pullRequests: prs.length, findings: out.slice(0, 200) };
} });
