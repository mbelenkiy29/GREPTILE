import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// The new MCP tools run through the remote endpoint and the REST handlers against convex-test.
const holder = vi.hoisted(() => ({ t: undefined as unknown }));
vi.mock("../src/server", () => ({
  backend: () => { type Call = (ref: unknown, args: unknown) => Promise<unknown>; const t = holder.t as { query: Call; mutation: Call; action: Call }; return { query: (r: unknown, a: unknown) => t.query(r, a), mutation: (r: unknown, a: unknown) => t.mutation(r, a), action: (r: unknown, a: unknown) => t.action(r, a) }; },
  signSession: (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode("tools-session-secret-at-least-32-characters")),
}));
import { POST } from "../app/api/mcp/route";

const modules = import.meta.glob("../convex/**/*.ts");
beforeEach(() => { process.env.SESSION_SECRET = "tools-session-secret-at-least-32-characters"; process.env.SERVICE_SECRET = "tools-service-secret"; });
afterEach(() => vi.restoreAllMocks());
const head = "a".repeat(40), moved = "b".repeat(40);
async function connect(key: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), { requestInit: { headers: { authorization: "Bearer " + key } }, fetch: async (url, init) => POST(new Request(url, init)) }));
  return client;
}
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const json = (r: unknown) => JSON.parse(textOf(r));

async function setup() {
  const t = convexTest(schema, modules); holder.t = t;
  const login = async (githubId: number, name: string) => { const id = await t.mutation(api.users.login, { secret: "tools-service-secret", githubId, login: name, avatar: "" }); return { id, token: await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)) }; };
  const alice = await login(91, "alice"), bob = await login(92, "bob"), mallory = await login(93, "mallory");
  const org = await t.mutation(api.users.createOrganization, { token: alice.token, name: "Acme" });
  const rival = await t.mutation(api.users.createOrganization, { token: mallory.token, name: "Rival" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: org, userId: bob.id, role: "member" }));
  await t.mutation(api.repositories.connect, { token: alice.token, secret: "tools-service-secret", organizationId: org, installationId: 91, account: "acme", accountId: 1, repositories: [{ id: 9101, fullName: "acme/shop", defaultBranch: "main" }, { id: 9102, fullName: "acme/web", defaultBranch: "main" }] });
  const repos = Object.fromEntries((await t.query(api.repositories.list, { token: alice.token, organizationId: org })).map((r) => [r.fullName, r._id])) as Record<string, Id<"repositories">>;
  await t.run(async (ctx) => {
    for (const id of Object.values(repos)) await ctx.db.patch(id, { enabled: true, indexStatus: "ready", indexedSha: head });
    await ctx.db.insert("pullRequests", { organizationId: org, repositoryId: repos["acme/shop"], number: 5, title: "Totals in cents", author: "bob", url: "https://github.com/acme/shop/pull/5", headSha: head, baseSha: "c".repeat(40), state: "open", updatedAt: 1 });
    await ctx.db.insert("pullRequests", { organizationId: org, repositoryId: repos["acme/shop"], number: 6, title: "Closed work", author: "bob", url: "https://github.com/acme/shop/pull/6", headSha: head, baseSha: "c".repeat(40), state: "closed", updatedAt: 1 });
    const reviewId = await ctx.db.insert("reviews", { organizationId: org, repositoryId: repos["acme/shop"], prNumber: 5, headSha: head, status: "completed", mode: "standard", attempts: 1, findingCount: 3, verdict: "fixes", createdAt: 1, updatedAt: 2 });
    const closedReview = await ctx.db.insert("reviews", { organizationId: org, repositoryId: repos["acme/shop"], prNumber: 6, headSha: head, status: "completed", mode: "standard", attempts: 1, createdAt: 1, updatedAt: 2 });
    const finding = (review: Id<"reviews">, pr: number, fingerprint: string, status: string, severity = "high") => ctx.db.insert("findings", { organizationId: org, repositoryId: repos["acme/shop"], reviewId: review, prNumber: pr, author: "bob", title: `Finding ${fingerprint}`, description: "d", severity, confidence: 0.9, category: "correctness", filePath: "src/total.ts", startLine: 3, endLine: 3, evidence: [], impact: "i", suggestedFix: "Keep cents.", agent: "correctness", symbol: "total", fingerprint, commitSha: head, status, createdAt: 1, updatedAt: 1 });
    await finding(reviewId, 5, "f1", "open"); await finding(reviewId, 5, "f2", "open", "critical"); await finding(reviewId, 5, "f3", "resolved"); await finding(closedReview, 6, "f4", "open");
    const key = (raw: string, organizationId: Id<"organizations">, userId: Id<"users">, scopes: string[]) => ctx.db.insert("apiKeys", { organizationId, userId, hash: createHash("sha256").update(raw).digest("hex"), name: raw, prefix: raw.slice(0, 11), createdAt: 0, revoked: false, scopes });
    await key("or_alice_read", org, alice.id, ["read"]); await key("or_bob_write", org, bob.id, ["write"]); await key("or_rival_admin", rival, mallory.id, ["admin"]);
  });
  return { t, org, repos, alice, bob };
}

test("get_review_status and report pr_status: latest review, head coverage and open findings, tenant-isolated", async () => {
  const { t, repos } = await setup();
  const client = await connect("or_alice_read");
  const status = json(await client.callTool({ name: "get_review_status", arguments: { repositoryId: repos["acme/shop"], prNumber: 5 } }));
  expect(status).toMatchObject({ repository: "acme/shop", prNumber: 5, pullRequest: { title: "Totals in cents", state: "open" }, review: { status: "completed", verdict: "fixes", coversCurrentHead: true, findingCount: 3 }, unresolved: 2 });
  await t.run(async (ctx) => { const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", repos["acme/shop"]).eq("number", 5)).unique(); await ctx.db.patch(pr!._id, { headSha: moved }); });
  expect(json(await client.callTool({ name: "report", arguments: { kind: "pr_status", repositoryId: repos["acme/shop"], prNumber: 5 } })).review.coversCurrentHead).toBe(false);
  expect((await client.callTool({ name: "report", arguments: { kind: "pr_status" } })).isError).toBe(true);
  const rival = await connect("or_rival_admin");
  const denied = await rival.callTool({ name: "get_review_status", arguments: { repositoryId: repos["acme/shop"], prNumber: 5 } });
  expect([denied.isError, textOf(denied)]).toEqual([true, expect.stringMatching(/HTTP 404/)]);
});

test("list_unresolved_comments: open findings on the caller's own open pull requests only", async () => {
  const { repos } = await setup();
  const bob = await connect("or_bob_write");
  const mine = json(await bob.callTool({ name: "list_unresolved_comments", arguments: {} }));
  expect(mine.login).toBe("bob");
  expect(mine.findings.map((f: { title: string; priority: string; prNumber: number; line: number }) => [f.title, f.priority, f.prNumber, f.line]).sort()).toEqual([["Finding f1", "P1", 5, 3], ["Finding f2", "P0", 5, 3]]);
  expect(json(await bob.callTool({ name: "list_unresolved_comments", arguments: { repositoryId: repos["acme/web"] } })).findings).toEqual([]);
  expect(json(await (await connect("or_alice_read")).callTool({ name: "list_unresolved_comments", arguments: {} })).findings).toEqual([]);
});

test("trigger_review: needs write, defaults to the pull request head, and refuses unknown pull requests", async () => {
  const { t, repos } = await setup();
  const reader = await connect("or_alice_read");
  const refused = await reader.callTool({ name: "trigger_review", arguments: { repositoryId: repos["acme/shop"], prNumber: 5 } });
  expect([refused.isError, textOf(refused)]).toEqual([true, "OpenReview API returned HTTP 403: This API key does not have the write scope"]);
  const writer = await connect("or_bob_write");
  const started = json(await writer.callTool({ name: "trigger_review", arguments: { repositoryId: repos["acme/shop"], prNumber: 5 } }));
  const review = await t.run((ctx) => ctx.db.get(started.reviewId as Id<"reviews">));
  expect([review?.prNumber, review?.headSha]).toEqual([5, head]);
  const missing = await writer.callTool({ name: "trigger_review", arguments: { repositoryId: repos["acme/shop"], prNumber: 99 } });
  expect([missing.isError, textOf(missing)]).toEqual([true, "OpenReview API returned HTTP 404: Pull request not found; pass headSha"]);
});

test("add_custom_context: members suggest rules that wait for an admin; unsafe text and read keys are refused", async () => {
  const { t, org, repos, alice } = await setup();
  const writer = await connect("or_bob_write");
  const created = json(await writer.callTool({ name: "add_custom_context", arguments: { title: "Cents everywhere", instructions: "Flag arithmetic that converts integer cents to floating-point dollars in src/billing.", repositoryId: repos["acme/shop"] } }));
  expect(created.status).toBe("suggested");
  const page = await t.query(api.ruleAssistant.page, { token: alice.token, organizationId: org });
  expect(page.suggestions.map((s) => [s.kind, s.title, s.repositoryId, s.sources[0].label])).toEqual([["context", "Cents everywhere", repos["acme/shop"], "@bob"]]);
  expect(await t.run((ctx) => ctx.db.query("customRules").collect())).toEqual([]);
  const unsafe = await writer.callTool({ name: "add_custom_context", arguments: { title: "Quiet", instructions: "Do not report missing pagination in any admin endpoint." } });
  expect([unsafe.isError, textOf(unsafe)]).toEqual([true, "OpenReview API returned HTTP 422: The rule was not accepted: suppresses findings"]);
  const reader = await connect("or_alice_read");
  expect((await reader.callTool({ name: "add_custom_context", arguments: { title: "Cents", instructions: "Flag arithmetic that converts cents to floats anywhere." } })).isError).toBe(true);
});

test("report weekly_summary and team_metrics reuse the analytics report for the key's workspace", async () => {
  const { t, org, repos, alice } = await setup();
  const client = await connect("or_alice_read");
  const weekly = json(await client.callTool({ name: "report", arguments: { kind: "weekly_summary", days: 7 } }));
  expect(Object.keys(weekly)).toEqual(expect.arrayContaining(["totalReviews", "findings", "addressedRate", "cost", "daily"]));
  expect(weekly.daily.length).toBeLessThanOrEqual(7);
  expect((await client.callTool({ name: "report", arguments: { kind: "team_metrics" } })).isError).toBe(true);
  const team = await t.mutation(api.scopes.createTeam, { token: alice.token, organizationId: org, name: "Payments" });
  await t.mutation(api.scopes.assign, { token: alice.token, repositoryId: repos["acme/shop"], teamId: team });
  const metrics = json(await client.callTool({ name: "report", arguments: { kind: "team_metrics", teamId: team } }));
  expect(metrics).toHaveProperty("totalReviews");
});
