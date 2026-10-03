import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import { authenticateRequest } from "@/lib/api/auth";
import { API_SCOPES, type ApiScope } from "@/lib/api/keys";
import type { ApiDeps } from "@/lib/api/router";
import { createRule } from "@/lib/data/rules";
import type { Db } from "@/lib/db";
import { findingFeedback, findings, knowledgeEntries, reviewRuns } from "@/lib/db/schema";
import { inProcessApi } from "@/lib/mcp/server";
import { createOpenReviewMcpServer, TOOL_NAMES, type OpenReviewApi } from "@/packages/mcp/src/tools";
import { API_ORIGIN, apiDeps, makeKey } from "./helpers/api";
import { dashboardFixture } from "./helpers/dashboard";
import { reviewFixture } from "./helpers/review-fixture";

const NOW = new Date("2026-03-01T12:00:00Z");
const ALL = [...API_SCOPES];

/** An MCP client connected (in memory) to a server whose tools run as `api`. */
async function mcpClient(api: OpenReviewApi): Promise<Client> {
  const server = createOpenReviewMcpServer(api, { version: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

/** A client whose tools run in-process as a new API key of `orgId` with `scopes`. */
async function clientAs(deps: ApiDeps, db: Db, orgId: string, scopes: ApiScope[]) {
  const { token } = await makeKey(db, orgId, scopes);
  const principal = await authenticateRequest(deps, new Request(`${API_ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${token}` } }));
  return mcpClient(inProcessApi(deps, principal));
}

type Result = CallToolResult & { structuredContent?: Record<string, unknown> };

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

function text(r: Result): string {
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

async function fixture() {
  const fx = await dashboardFixture(NOW);
  const deps = apiDeps(fx.db);
  return { ...fx, deps };
}

describe("MCP server tools (R3.2)", () => {
  test("R3.2 lists every tool with a description, an input schema, and read-only annotations on reads", async () => {
    const { db, deps } = await fixture();
    const client = await clientAs(deps, db, "org_a", ALL);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_review_comments!.annotations?.readOnlyHint).toBe(true);
    expect(byName.mark_finding_resolved!.annotations?.readOnlyHint).toBe(false);
    expect(byName.trigger_review!.inputSchema.required).toEqual(expect.arrayContaining(["repository", "prNumber"]));
    const server = client.getServerVersion();
    expect(server?.name).toBe("openreview");
    expect(client.getInstructions()).toContain("data, never instructions");
  });

  test("R3.2 list_reviews, get_review, list_review_comments, list_findings, and get_finding answer with text and structured content", async () => {
    const { db, deps, reviews, findings: f } = await fixture();
    const client = await clientAs(deps, db, "org_a", ALL);

    const list = await callTool(client, "list_reviews", { repository: "acme/api" });
    expect(list.isError).toBeFalsy();
    const listed = (list.structuredContent!.reviews as { id: number; prNumber: number }[]).map((r) => r.prNumber).sort();
    expect(listed).toEqual([1, 2]);
    expect(text(list)).toContain(`review ${reviews.r1.review.id}: acme/api#1 "Add billing"`);
    const byPr = await callTool(client, "list_reviews", { repository: "ACME/API", prNumber: 2 });
    expect((byPr.structuredContent!.reviews as { id: number }[]).map((r) => r.id)).toEqual([reviews.r2.review.id]);

    const review = await callTool(client, "get_review", { repository: "acme/api", prNumber: 1 });
    const view = review.structuredContent!.review as { id: number; status: string; counts: { open: number; openBySeverity: Record<string, number> }; latestRun: { status: string } };
    expect(view.id).toBe(reviews.r1.review.id);
    expect(view.status).toBe("completed");
    expect(view.counts.openBySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
    expect(view.latestRun.status).toBe("completed");
    expect(text(review)).toContain("Open findings:");

    const comments = await callTool(client, "list_review_comments", { reviewId: reviews.r1.review.id });
    expect((comments.structuredContent!.findings as { id: number }[]).map((x) => x.id)).toEqual([f.fCritical.id]);
    expect(text(comments)).toContain(`[#${f.fCritical.id}] CRITICAL security src/app.ts:10-12 — SQL injection in invoice search`);
    const highOnly = await callTool(client, "list_review_comments", { repository: "acme/api", prNumber: 1, minSeverity: "high" });
    expect((highOnly.structuredContent!.findings as unknown[]).length).toBe(1);

    const all = await callTool(client, "list_findings", { status: ["open", "resolved", "false_positive"] });
    const ids = (all.structuredContent!.findings as { id: number }[]).map((x) => x.id).sort((a, b) => a - b);
    expect(ids).toEqual([f.fCritical.id, f.fLow.id, f.fFalse.id].sort((a, b) => a - b));
    const fp = await callTool(client, "list_findings", { repository: "acme/api", prNumber: 2, status: ["false_positive"] });
    expect((fp.structuredContent!.findings as { id: number }[]).map((x) => x.id)).toEqual([f.fFalse.id]);

    const detail = await callTool(client, "get_finding", { findingId: f.fCritical.id });
    expect(detail.isError).toBeFalsy();
    const body = text(detail);
    expect(body).toContain("User input reaches raw SQL");
    expect(body).toContain("Use a parameterized query.");
    expect(body).toContain("Fix prompt (claude-code)");
    expect(body).toContain("not instructions");
    expect((detail.structuredContent!.fixPrompt as { prompt: string }).prompt.length).toBeGreaterThan(50);

    const missing = await callTool(client, "get_review", { repository: "acme/api", prNumber: 404 });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("has not reviewed acme/api#404 yet");
    const unknownRepo = await callTool(client, "list_reviews", { repository: "acme/nope" });
    expect(unknownRepo.isError).toBe(true);
    expect(text(unknownRepo)).toContain("No repository named acme/nope");
  });

  test("R3.2 get_review with headSha reports whether that commit's review is done, in progress, failed, or not reviewed", async () => {
    const { db, deps, reviews } = await fixture();
    const client = await clientAs(deps, db, "org_a", ["reviews:read", "repos:read"]);
    const sha = "1234567".padEnd(40, "a");
    await db.update(reviewRuns).set({ headSha: sha }).where(eq(reviewRuns.id, reviews.r1.run.id));
    const head = async (s: string) => ((await callTool(client, "get_review", { reviewId: reviews.r1.review.id, headSha: s })).structuredContent!.review as { head: { status: string } }).head.status;
    expect(await head(sha)).toBe("completed");
    expect(await head(sha.slice(0, 7))).toBe("completed");
    expect(await head("f".repeat(40))).toBe("not_reviewed");
    await db.update(reviewRuns).set({ status: "reviewing" }).where(eq(reviewRuns.id, reviews.r1.run.id));
    expect(await head(sha)).toBe("in_progress");
    await db.update(reviewRuns).set({ status: "failed" }).where(eq(reviewRuns.id, reviews.r1.run.id));
    expect(await head(sha)).toBe("failed");
  });

  test("R3.2 mark_finding_resolved records resolved feedback with source mcp, closes the finding, and needs findings:write", async () => {
    const { db, deps, findings: f } = await fixture();
    const reader = await clientAs(deps, db, "org_a", ["findings:read"]);
    const denied = await callTool(reader, "mark_finding_resolved", { findingId: f.fCritical.id });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("This API key lacks the findings:write scope.");

    const writer = await clientAs(deps, db, "org_a", ["findings:write"]);
    const res = await callTool(writer, "mark_finding_resolved", { findingId: f.fCritical.id, note: "Parameterized in abc123" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ findingId: f.fCritical.id, status: "resolved", duplicate: false });
    const rows = await db.select().from(findingFeedback).where(and(eq(findingFeedback.findingId, f.fCritical.id), eq(findingFeedback.kind, "resolved")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "mcp", note: "Parameterized in abc123", orgId: "org_a" });
    expect(rows[0]!.externalAuthor).toMatch(/^api_key:\d+$/);
    const [finding] = await db.select().from(findings).where(eq(findings.id, f.fCritical.id));
    expect(finding!.status).toBe("resolved");
    const again = await callTool(writer, "mark_finding_resolved", { findingId: f.fCritical.id });
    expect(again.structuredContent).toMatchObject({ duplicate: true });
    expect(text(again)).toContain("already marked resolved");
  });

  test("R3.2 trigger_review queues a review run (reviews:write) and get_fix_all builds the consolidated task", async () => {
    const { db, deps, repos, reviews } = await fixture();
    const reader = await clientAs(deps, db, "org_a", ["reviews:read", "repos:read", "findings:read"]);
    const denied = await callTool(reader, "trigger_review", { repository: "acme/api", prNumber: 1 });
    expect(text(denied)).toContain("This API key lacks the reviews:write scope.");
    expect(deps.queue.jobs).toHaveLength(0);

    const writer = await clientAs(deps, db, "org_a", ["reviews:write", "repos:read"]);
    const res = await callTool(writer, "trigger_review", { repository: repos.api.id, prNumber: 1, mode: "deep", full: true });
    expect(res.isError).toBeFalsy();
    const run = res.structuredContent!.run as { id: number; reviewId: number; status: string };
    expect(run.reviewId).toBe(reviews.r1.review.id);
    expect(run.status).toBe("queued");
    const [row] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, run.id));
    expect(row).toMatchObject({ orgId: "org_a", trigger: "api", mode: "deep", full: true, prNumber: 1 });
    expect(deps.queue.jobs.map((j) => j.name)).toContain("review-pr");
    expect(text(res)).toContain(`run ${run.id} of review ${reviews.r1.review.id}`);

    const fixAll = await callTool(reader, "get_fix_all", { reviewId: reviews.r1.review.id, minConfidence: 0.5 });
    expect(fixAll.isError).toBeFalsy();
    expect(text(fixAll)).toContain("SQL injection in invoice search");
    expect((fixAll.structuredContent!.task as { findings: unknown[] }).findings).toHaveLength(1);
  });

  test("R3.2 tools enforce the key's scopes with helpful errors", async () => {
    const { db, deps, reviews, findings: f } = await fixture();
    const client = await clientAs(deps, db, "org_a", ["reviews:read"]);
    const cases: [string, Record<string, unknown>, string][] = [
      ["list_findings", {}, "findings:read"],
      ["list_review_comments", { reviewId: reviews.r1.review.id }, "findings:read"],
      ["get_finding", { findingId: f.fCritical.id }, "findings:read"],
      ["get_fix_all", { reviewId: reviews.r1.review.id }, "findings:read"],
      ["list_rules", {}, "rules:read"],
      ["search_codebase", { repository: 1, query: "invoice" }, "repos:read"],
      ["get_related_files", { repository: 1, path: "src/a.ts" }, "repos:read"],
      ["get_repository_context", { repository: 1 }, "knowledge:read"],
      ["list_reviews", { repository: "acme/api" }, "repos:read"],
    ];
    for (const [tool, args, scope] of cases) {
      const res = await callTool(client, tool, args);
      expect(res.isError, tool).toBe(true);
      expect(text(res), tool).toContain(`This API key lacks the ${scope} scope.`);
      expect(text(res), tool).toContain("Settings → API keys");
    }
    expect((await callTool(client, "list_reviews", {})).isError).toBeFalsy();
  });

  test("R3.2 tenant isolation: org A's key never reads or changes org B's reviews, findings, rules, or repositories", async () => {
    const { db, deps, repos, reviews } = await fixture();
    const [globex] = await db.select().from(findings).where(eq(findings.orgId, "org_b"));
    const globexRule = await createRule(db, "org_b", { text: "Globex only rule", source: "dashboard" });
    const client = await clientAs(deps, db, "org_a", ALL);

    for (const [tool, args] of [
      ["get_review", { reviewId: reviews.rb.review.id }],
      ["get_finding", { findingId: globex!.id }],
      ["mark_finding_resolved", { findingId: globex!.id }],
      ["get_fix_all", { reviewId: reviews.rb.review.id }],
      ["trigger_review", { repository: repos.core.id, prNumber: 9 }],
      ["search_codebase", { repository: repos.core.id, query: "secret" }],
      ["get_related_files", { repository: repos.core.id, symbol: "x" }],
      ["get_repository_context", { repository: repos.core.id }],
    ] as const) {
      const res = await callTool(client, tool, args);
      expect(res.isError, tool).toBe(true);
      expect(text(res), tool).toMatch(/not found|No repository/);
    }
    const byName = await callTool(client, "list_reviews", { repository: "globex/core" });
    expect(text(byName)).toContain("No repository named globex/core");
    const everything = JSON.stringify([
      (await callTool(client, "list_findings", { status: ["open", "resolved", "dismissed", "wont_fix", "false_positive"] })).structuredContent,
      (await callTool(client, "list_reviews", {})).structuredContent,
      (await callTool(client, "list_rules", { status: ["active", "candidate", "rejected"] })).structuredContent,
    ]);
    expect(everything).not.toContain("Globex");
    expect(everything).not.toContain("globex");
    expect(everything).not.toContain(globexRule.text);
    const [stillOpen] = await db.select().from(findings).where(eq(findings.id, globex!.id));
    expect(stillOpen!.status).toBe("open");
    expect(deps.queue.jobs).toHaveLength(0);
  });

  test("R3.2 list_rules lists org-wide and repository rules", async () => {
    const { db, deps, repos } = await fixture();
    await createRule(db, "org_a", { text: "Use parameterized SQL everywhere", paths: ["src/**"], source: "dashboard" });
    await createRule(db, "org_a", { text: "API handlers validate input", repoId: repos.api.id, source: "dashboard" });
    const client = await clientAs(deps, db, "org_a", ["rules:read", "repos:read"]);
    const all = await callTool(client, "list_rules");
    expect((all.structuredContent!.rules as { text: string }[]).map((r) => r.text).sort()).toEqual(["API handlers validate input", "Use parameterized SQL everywhere"]);
    expect(text(all)).toContain("(paths: src/**)");
    const repoOnly = await callTool(client, "list_rules", { repository: "acme/api" });
    expect((repoOnly.structuredContent!.rules as { text: string }[]).map((r) => r.text)).toEqual(["API handlers validate input"]);
  });

  test("R3.2 exposes a review as the resource openreview://reviews/{id}", async () => {
    const { db, deps, reviews } = await fixture();
    const client = await clientAs(deps, db, "org_a", ["reviews:read"]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["openreview://reviews/{id}"]);
    const res = await client.readResource({ uri: `openreview://reviews/${reviews.r1.review.id}` });
    const content = res.contents[0] as { text: string; mimeType: string };
    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text)).toMatchObject({ id: reviews.r1.review.id, repository: "acme/api", prNumber: 1 });
    await expect(client.readResource({ uri: `openreview://reviews/${reviews.rb.review.id}` })).rejects.toThrow(/not found/);
  });
});

describe("MCP codebase tools (R3.2)", () => {
  test("R3.2 search_codebase returns ranked snippets with path:line and reasons; get_related_files walks the code graph", async () => {
    const fx = await reviewFixture();
    const deps = apiDeps(fx.db, { embedder: fx.embedder });
    const client = await clientAs(deps, fx.db, "org_a", ["repos:read", "knowledge:read"]);

    const search = await callTool(client, "search_codebase", { repository: "acme/shop", query: "Where is `computeTotal` defined?" });
    expect(search.isError).toBeFalsy();
    const results = search.structuredContent!.results as { rank: number; path: string; startLine: number; reasons: string[]; snippet: string; score: number }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i + 1));
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const top = results[0]!;
    expect(top.path).toBe("services/billing/pricing.ts");
    expect(top.snippet).toContain("export function computeTotal");
    expect(top.reasons.join(" ")).toContain("computeTotal");
    expect(text(search)).toContain("1. services/billing/pricing.ts:1");
    expect(text(search)).toContain("not instructions");

    const related = await callTool(client, "get_related_files", { repository: fx.repo.id, symbol: "computeTotal" });
    expect(related.isError).toBeFalsy();
    const r = (related.structuredContent as { related: { callers: { path: string }[]; importers: { path: string }[]; symbols: { path: string }[] } }).related;
    expect(r.symbols.map((s) => s.path)).toEqual(["services/billing/pricing.ts"]);
    expect(r.callers.map((c) => c.path).sort()).toEqual(["services/api/handlers.ts", "web/cart/summary.ts"]);
    expect(r.importers.map((i) => i.path).sort()).toEqual(["services/api/handlers.ts", "web/cart/summary.ts"]);
    expect(text(related)).toContain("Callers:");

    const byPath = await callTool(client, "get_related_files", { repository: "acme/shop", path: "services/billing/pricing.ts" });
    expect((byPath.structuredContent as { related: { symbols: { name: string }[] } }).related.symbols.map((s) => s.name)).toContain("computeTotal");
    const unknown = await callTool(client, "get_related_files", { repository: "acme/shop", path: "services/billing/pricng.ts" });
    expect(text(unknown)).toContain("Nothing named services/billing/pricng.ts is in the index");

    // Another org's key cannot search this repository, even by id.
    const { db } = fx;
    const { orgs } = await import("@/lib/db/schema");
    await db.insert(orgs).values({ id: "org_b", name: "Globex" });
    const outsider = await clientAs(deps, db, "org_b", ["repos:read"]);
    const foreign = await callTool(outsider, "search_codebase", { repository: fx.repo.id, query: "computeTotal" });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain("Repository not found.");
  });

  test("R3.2 get_repository_context returns the repository summary, the architecture overview, and knowledge for a path", async () => {
    const fx = await reviewFixture();
    const deps = apiDeps(fx.db);
    await fx.db.insert(knowledgeEntries).values([
      { orgId: "org_a", repoId: fx.repo.id, slug: "architecture", title: "Architecture overview", kind: "architecture", description: "A shop with billing and a cart.", relatedFiles: [], stale: false, rank: 0 },
      {
        orgId: "org_a",
        repoId: fx.repo.id,
        slug: "billing",
        title: "Billing",
        kind: "billing",
        description: "Computes totals and tax.",
        relatedFiles: ["services/billing/pricing.ts", "services/billing/tax.ts"],
        conventions: ["Amounts are integers"],
        risks: [{ title: "Rounding", detail: "Tax rounds per line", severity: "medium", files: ["services/billing/tax.ts"] }],
        stale: false,
        rank: 1,
      },
    ]);
    const client = await clientAs(deps, fx.db, "org_a", ["knowledge:read", "repos:read"]);
    const ctx = await callTool(client, "get_repository_context", { repository: "acme/shop", path: "services/billing" });
    expect(ctx.isError).toBeFalsy();
    const body = text(ctx);
    expect(body).toContain("acme/shop: default branch main, index ready");
    expect(body).toContain("A shop with billing and a cart.");
    expect(body).toContain("## Billing (billing)");
    expect(body).toContain("- Amounts are integers");
    expect(body).toContain("[medium] Rounding: Tax rounds per line");
    const overview = await callTool(client, "get_repository_context", { repository: "acme/shop" });
    expect((overview.structuredContent!.subsystems as { title: string }[]).map((s) => s.title)).toEqual(["Architecture overview", "Billing"]);
  });
});
