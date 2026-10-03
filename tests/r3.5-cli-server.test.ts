import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { ApiScope } from "@/lib/api/keys";
import { listAudit } from "@/lib/data/audit";
import { findings, orgs, pullRequests, repos, reviewRuns, reviews, usageEvents } from "@/lib/db/schema";
import { cliReviewJsonSchema } from "@/packages/cli/src/render";
import { createApiKey } from "@/lib/api/keys";
import { apiDeps, call, json, makeKey } from "./helpers/api";
import { makeUser } from "./helpers/auth";
import { CLI_SERVER, cli, testIo } from "./helpers/cli";
import { callerBug, engineLlm, reviewCalls } from "./helpers/engine";
import { reviewFixture } from "./helpers/review-fixture";

const WRITE: ApiScope[] = ["repos:read", "reviews:read", "reviews:write", "findings:read"];

/** acme/shop indexed on the server (org_a), a checkout of its `feature` branch, and a key for the CLI. */
async function setup(scopes: ApiScope[] = WRITE) {
  const fx = await reviewFixture();
  fx.fixture.git("remote", "add", "origin", "https://github.com/acme/shop.git");
  const llm = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug()] : [] }) });
  const deps = apiDeps(fx.db, { reviewEngine: () => ({ llm, embedder: fx.embedder }) });
  // A key made by `openreview login` belongs to the approving member; usage is attributed to their GitHub login.
  const dana = await makeUser(fx.db, "dana");
  const { token } = await createApiKey(fx.db, { orgId: "org_a", createdBy: dana.id, name: "CLI on dev-laptop", scopes, expiresInDays: null });
  const env = { OPENREVIEW_URL: CLI_SERVER, OPENREVIEW_TOKEN: token };
  return { ...fx, llm, deps, token, env, io: () => testIo({ cwd: fx.fixture.dir, deps: { api: deps }, env }) };
}

/** PR #7 (head branch `feature`) with a completed review and findings, as the GitHub pipeline would leave it. */
async function seedPrReview(s: Awaited<ReturnType<typeof setup>>) {
  const { db } = s;
  const [pr] = await db
    .insert(pullRequests)
    .values({ orgId: "org_a", repoId: s.repo.id, number: 7, title: "Add tax to totals", author: "dev", baseRef: "main", headRef: "feature", baseSha: s.base, headSha: s.head, url: "https://github.com/acme/shop/pull/7" })
    .returning();
  const [review] = await db
    .insert(reviews)
    .values({ orgId: "org_a", repoId: s.repo.id, prNumber: 7, prTitle: "Add tax to totals", headSha: s.head, status: "completed", pullRequestId: pr!.id, runs: 1, riskLevel: "high" })
    .returning();
  const [run] = await db.insert(reviewRuns).values({ orgId: "org_a", repoId: s.repo.id, reviewId: review!.id, prNumber: 7, trigger: "opened", status: "completed" }).returning();
  await db.update(reviews).set({ lastRunId: run!.id }).where(eq(reviews.id, review!.id));
  const base = { orgId: "org_a", repoId: s.repo.id, reviewId: review!.id, prNumber: 7, agent: "correctness", agents: ["correctness"], confidence: 0.9, commitSha: s.head, firstSeenSha: s.head, visibility: "published" as const };
  const rows = await db
    .insert(findings)
    .values([
      { ...base, fingerprint: "f1", title: "Callers of computeTotal break", severity: "high", category: "correctness", path: "services/billing/pricing.ts", startLine: 3, endLine: 3, description: "Two callers pass one argument.", suggestedFix: "Default region." },
      { ...base, fingerprint: "f2", title: "Rounding drops cents", severity: "low", category: "correctness", path: "services/billing/tax.ts", startLine: 2, endLine: 2, description: "Math.round on cents." },
      { ...base, fingerprint: "f3", title: "Old issue", severity: "medium", category: "testing", path: "web/cart/summary.ts", startLine: 4, endLine: 4, status: "resolved" },
    ])
    .returning();
  return { review: review!, run: run!, findings: rows };
}

describe("openreview CLI against a server (R3.5)", () => {
  test("R3.5 review in server mode posts the diff to /api/v1/reviews/local, reviews it against the server's index, records cli usage, and posts nothing to GitHub", async () => {
    const s = await setup();
    const io = s.io();
    const res = await cli(io, "review", "--json", "--fail-on", "high");
    expect(res.err).toBe("");
    expect(res.code).toBe(1);
    const out = cliReviewJsonSchema.parse(JSON.parse(res.out));
    expect(out).toMatchObject({ source: "server", repository: { id: s.repo.id, fullName: "acme/shop" }, baseRef: "main", headRef: "feature", exitCode: 1, counts: { high: 1 } });
    expect(out.usage.credits).toBe(2);
    expect(out.findings[0]).toMatchObject({ path: "services/billing/pricing.ts", startLine: 3, severity: "high" });

    const post = io.requests.find((r) => r.method === "POST")!;
    expect(post).toMatchObject({ url: "/api/v1/reviews/local", authorization: `Bearer ${s.token}` });
    const body = post.body as { repositoryId: number; baseSha: string; headSha: string; files: { path: string; status: string; patch: string }[]; headFiles: Record<string, string> };
    expect(body).toMatchObject({ repositoryId: s.repo.id, baseSha: s.base, headSha: s.head, headRef: "feature", baseRef: "main" });
    expect(body.files).toEqual([expect.objectContaining({ path: "services/billing/pricing.ts", status: "modified", patch: expect.stringMatching(/^@@ /) })]);
    expect(Object.keys(body.headFiles)).toEqual(["services/billing/pricing.ts"]);

    // The engine saw the base version (rebuilt from the diff) and the callers from the server's index.
    const prompt = reviewCalls(s.llm).find((c) => c.req.meta?.agent === "correctness")!.req.prompt;
    expect(prompt).toContain("before: export function computeTotal(items: number[]) {");
    expect(prompt).toContain("handleCheckout");

    const usage = await s.db.select().from(usageEvents).where(eq(usageEvents.orgId, "org_a"));
    expect(usage).toEqual([expect.objectContaining({ repoId: s.repo.id, kind: "review", trigger: "cli", credits: 2, reviewRunId: null, author: "dana" })]);
    expect(usage[0]!.inputTokens).toBeGreaterThan(0);
    expect((await listAudit(s.db, "org_a")).map((a) => a.action)).toEqual(["review.local_completed"]);
    // No pull request review was created or published.
    expect(await s.db.select().from(reviews)).toEqual([]);
    expect([...s.host.reviewComments.values()].flat()).toEqual([]);
  });

  test("R3.5 server review: a model failure is reported (503) instead of an empty review, and no credits are charged", async () => {
    const s = await setup();
    const failing = engineLlm({
      review: () => {
        throw new Error("upstream overloaded");
      },
    });
    const deps = { ...s.deps, reviewEngine: () => ({ llm: failing, embedder: s.embedder }) };
    const io = testIo({ cwd: s.fixture.dir, deps: { api: deps }, env: s.env });
    const res = await cli(io, "review");
    expect(res.code).toBe(2);
    expect(res.err).toContain("error: The server couldn't run the review: The review model failed: Every review model call failed");
    expect(res.err).toContain("Try again later, or review with --local.");
    expect(await s.db.select().from(usageEvents)).toEqual([]);
  });

  test("R3.5 /api/v1/reviews/local checks scope and tenant: other orgs' repositories are 404, and unindexed repositories are refused with a hint", async () => {
    const s = await setup(["repos:read", "reviews:read"]);
    const noWrite = await cli(s.io(), "review", "--server");
    expect(noWrite.code).toBe(2);
    expect(noWrite.err).toContain("error: This API key lacks the reviews:write scope.");

    // Org B cannot review (or even find) org A's repository.
    await s.db.insert(orgs).values({ id: "org_b", name: "Globex" });
    const other = await makeKey(s.db, "org_b", WRITE);
    const body = { repositoryId: s.repo.id, baseSha: s.base, headSha: s.head, files: [{ path: "a.ts", status: "added", patch: "@@ -0,0 +1 @@\n+x" }], headFiles: { "a.ts": "x\n" } };
    expect((await call(s.deps, "POST /reviews/local", { token: other.token, body })).status).toBe(404);
    const byName = await call(s.deps, "POST /reviews/local", { token: other.token, body: { ...body, repositoryId: undefined, repoFullName: "acme/shop" } });
    expect(byName.status).toBe(404);
    const otherIo = testIo({ cwd: s.fixture.dir, deps: { api: s.deps }, env: { OPENREVIEW_URL: CLI_SERVER, OPENREVIEW_TOKEN: other.token } });
    const notConnected = await cli(otherIo, "review", "--server");
    expect(notConnected.err).toContain("acme/shop is not connected to https://review.example.com.");
    expect(await s.db.select().from(usageEvents)).toEqual([]);

    // Input is validated: paths must stay inside the repository.
    const writer = await makeKey(s.db, "org_a", WRITE);
    const traversal = await call(s.deps, "POST /reviews/local", { token: writer.token, body: { ...body, files: [{ path: "../etc/passwd", status: "added" }] } });
    expect(traversal.status).toBe(400);
    expect((await json<{ error: { message: string } }>(traversal)).error.message).toContain("must be a relative path inside the repository");

    await s.db.update(repos).set({ indexedSha: null, indexStatus: "indexing" }).where(eq(repos.id, s.repo.id));
    const writerIo = testIo({ cwd: s.fixture.dir, deps: { api: s.deps }, env: { OPENREVIEW_URL: CLI_SERVER, OPENREVIEW_TOKEN: writer.token } });
    const unindexed = await cli(writerIo, "review");
    expect(unindexed.code).toBe(2);
    expect(unindexed.err).toContain("acme/shop has not been indexed yet (status: indexing)");
    expect(unindexed.err).toContain("Run `openreview review --local`");
  });

  test("R3.5 whoami and status report the connection and the current branch's pull request review with findings by severity", async () => {
    const s = await setup();
    const seeded = await seedPrReview(s);
    const io = s.io();

    const who = await cli(io, "whoami");
    expect(who.out).toContain("Server:       https://review.example.com");
    expect(who.out).toContain("Credentials:  OPENREVIEW_TOKEN");

    const status = await cli(io, "status");
    expect(status.code).toBe(0);
    expect(status.out).toContain("Status:       connected, key valid");
    expect(status.out).toContain("Pull request #7 · acme/shop");
    expect(status.out).toContain(`Latest run:   #${seeded.run.id} completed (opened)`);
    expect(status.out).toContain("Findings:     1 high, 1 medium, 1 low");
    expect(status.out).toContain("Open findings (2)");
    expect(status.out).toContain(`[high] services/billing/pricing.ts:3 Callers of computeTotal break (id ${seeded.findings[0]!.id})`);
    expect(io.requests.some((r) => r.url.startsWith("/api/v1/reviews?") && r.url.includes("headRef=feature") && r.url.includes("repository=acme%2Fshop"))).toBe(true);

    const asJson = JSON.parse((await cli(io, "status", "--json")).out) as { connection: { organization: { id: string } }; pullRequest: { number: number; openFindings: unknown[]; findings: Record<string, number> } };
    expect(asJson.connection.organization.id).toBe("org_a");
    expect(asJson.pullRequest).toMatchObject({ number: 7, findings: { critical: 0, high: 1, medium: 1, low: 1 } });
    expect(asJson.pullRequest.openFindings).toHaveLength(2);

    // Detached HEAD: status still reports the connection and explains; --pr finds the review anyway.
    s.fixture.git("checkout", "--quiet", "--detach");
    const detached = await cli(io, "status");
    expect(detached.code).toBe(0);
    expect(detached.out).toContain("HEAD is detached, so there is no branch to find a pull request for.");
    expect((await cli(io, "findings")).err).toContain("HEAD is detached");
    expect((await cli(io, "status", "--pr", "7")).out).toContain("Pull request #7");
    s.fixture.git("checkout", "--quiet", "feature");

    const missing = await cli(io, "status", "--pr", "99");
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("No review found for #99 in acme/shop.");
    const unknownRepo = await cli(io, "status", "--repo", "acme/other");
    expect(unknownRepo.err).toContain("acme/other is not connected to OpenReview.");

    const down = testIo({ cwd: s.fixture.dir, env: s.env, fetchImpl: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })) });
    const unreachable = await cli(down, "status");
    expect(unreachable.code).toBe(2);
    expect(unreachable.err).toContain("Can't reach the OpenReview server at https://review.example.com (ENOTFOUND).");
    expect(unreachable.err + unreachable.out).not.toContain(s.token);
  });

  test("R3.5 findings, fix-prompt, and fix-all print the pull request's unresolved findings and fix prompts (--agent, --json, --copy)", async () => {
    const s = await setup();
    const seeded = await seedPrReview(s);
    const io = s.io();

    const agent = await cli(io, "findings", "--agent");
    expect(agent.code).toBe(0);
    expect(agent.out).toContain("# OpenReview: 2 open findings on acme/shop #7 (Add tax to totals)");
    expect(agent.out).toContain(`## 1. services/billing/pricing.ts:3\nseverity: high · id: ${seeded.findings[0]!.id} · category: correctness`);
    expect(agent.out).toContain("## 2. services/billing/tax.ts:2");
    expect(agent.out).toContain("## Fix all\n- [ ] services/billing/pricing.ts:3 — [high] Callers of computeTotal break\n- [ ] services/billing/tax.ts:2 — [low] Rounding drops cents");
    expect(agent.out).not.toContain("Old issue");

    const asJson = JSON.parse((await cli(io, "findings", "--json")).out) as { total: number; findings: { id: number }[] };
    expect(asJson.total).toBe(2);
    expect(asJson.findings.map((f) => f.id)).toEqual([seeded.findings[0]!.id, seeded.findings[1]!.id]);

    const prompt = await cli(io, "fix-prompt", String(seeded.findings[0]!.id), "--copy");
    expect(prompt.code).toBe(0);
    expect(prompt.out).toContain("Callers of computeTotal break");
    expect(prompt.out).toContain("services/billing/pricing.ts");
    expect(io.copied).toHaveLength(1);
    expect(prompt.out.trimEnd()).toBe(io.copied[0]!.trimEnd());
    expect(prompt.err).toContain("Copied to the clipboard (pbcopy).");
    const cursor = await cli(io, "fix-prompt", String(seeded.findings[0]!.id), "--for", "cursor");
    expect(cursor.code).toBe(0);
    expect(io.requests.at(-1)!.url).toContain("agent=cursor");
    const missing = await cli(io, "fix-prompt", "999999");
    expect(missing.err).toContain("Finding 999999 was not found in your organization.");
    expect((await cli(io, "fix-prompt", "abc")).err).toContain('"abc" is not a finding id.');

    const all = await cli(io, "fix-all", "--pr", "7");
    expect(all.code).toBe(0);
    expect(all.out).toContain("Callers of computeTotal break");
    expect(all.out).toContain("services/billing/tax.ts");
    expect(io.requests.at(-1)!.url).toBe(`/api/v1/reviews/${seeded.review.id}/fix-all?format=md`);

    // Another org's key sees none of it.
    await s.db.insert(orgs).values({ id: "org_b", name: "Globex" });
    const other = await makeKey(s.db, "org_b", WRITE);
    const otherIo = testIo({ cwd: s.fixture.dir, deps: { api: s.deps }, env: { OPENREVIEW_URL: CLI_SERVER, OPENREVIEW_TOKEN: other.token } });
    expect((await cli(otherIo, "findings")).err).toContain("acme/shop is not connected to OpenReview.");
    expect((await cli(otherIo, "fix-prompt", String(seeded.findings[0]!.id))).err).toContain("was not found in your organization");
    expect(await s.db.select().from(findings).where(and(eq(findings.orgId, "org_b")))).toEqual([]);
  });
});
