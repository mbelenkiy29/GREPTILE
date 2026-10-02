import { afterEach, describe, expect, test } from "vitest";
import { buildReviewContext } from "@/lib/review/context";
import { parsePatch } from "@/lib/review/diff";
import { reviewPullRequest } from "@/lib/review/engine";
import type { RawFinding } from "@/lib/review/findings";
import { rankFindings } from "@/lib/review/rank";
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const PRICING = "services/billing/pricing.ts";

function finding(over: Partial<RawFinding>): RawFinding {
  return {
    path: PRICING,
    line: 3,
    endLine: null,
    severity: "high",
    title: "Callers do not pass region",
    body: "handleCheckout and renderSummary call computeTotal with one argument.",
    suggestion: null,
    confidence: 4,
    ...over,
  };
}

const agentOf = (call: FakeCall) => /OpenReview's (\w+) reviewer/.exec(call.req.system)?.[1] ?? "summary";

const summaryOut = { whatChanged: ["Adds tax to totals"], riskLevel: "high", riskRationale: "Breaks callers.", confidence: 2 };

describe("review engine", () => {
  test("R1.4 retrieves callers, callees, and importers beyond the diff through the graph", async () => {
    fx = await reviewFixture();
    const files = await fx.client.listPullRequestFiles("acme/shop", 7);
    const diffs = files.map((f) => parsePatch(f.path, f.status, f.patch));
    const ctx = await buildReviewContext(
      { db: fx.db, embedder: fx.embedder },
      { orgId: "org_a", repoId: fx.repo.id, diffs, headContent: new Map([[PRICING, (await fx.client.getFileContent("acme/shop", PRICING, fx.head))!]]) },
    );

    expect(ctx.changed.map((s) => s.name)).toEqual(["computeTotal"]);
    const rel = (r: string) => ctx.impacted.filter((i) => i.relation === r).map((i) => `${i.path}:${i.name}`).sort();
    expect(rel("caller")).toEqual(["services/api/handlers.ts:handleCheckout", "web/cart/summary.ts:renderSummary"]);
    expect(rel("callee")).toEqual(["services/billing/tax.ts:taxFor"]);
    expect(rel("importer")).toEqual(["services/api/handlers.ts:services/api/handlers.ts", "web/cart/summary.ts:web/cart/summary.ts"]);
    expect(ctx.impacted.find((i) => i.name === "handleCheckout")?.content).toContain("computeTotal(req.items)");
    expect(ctx.components).toEqual(["services/api", "services/billing", "web/cart"]);
    // Nothing is retrieved for another tenant.
    const other = await buildReviewContext({ db: fx.db }, { orgId: "org_b", repoId: fx.repo.id, diffs, headContent: new Map() });
    expect(other.impacted).toEqual([]);
  });

  test("R1.4 runs logic, security, and style reviewers in parallel with the impacted context", async () => {
    fx = await reviewFixture();
    let inFlight = 0;
    let maxInFlight = 0;
    const llm = new FakeLlm(async (call) => {
      if (agentOf(call) === "summary") return summaryOut;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { findings: [] };
    });
    const result = await reviewPullRequest(
      { db: fx.db, llm, embedder: fx.embedder },
      { orgId: "org_a", repoId: fx.repo.id, repoFullName: "acme/shop", prNumber: 7, client: fx.client },
    );

    expect(maxInFlight).toBe(3);
    const reviewerCalls = llm.calls.filter((c) => agentOf(c) !== "summary");
    expect(reviewerCalls.map(agentOf).sort()).toEqual(["logic", "security", "style"]);
    for (const c of reviewerCalls) {
      expect(c.req.prompt).toContain("caller of services/billing/pricing.ts:computeTotal: services/api/handlers.ts");
      expect(c.req.prompt).toContain("export function taxFor");
      expect(c.req.prompt).toMatch(/\s3 \+ export function computeTotal\(items: number\[\], region: string\)/);
    }
    expect(result.summary).toEqual(summaryOut);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  test("R1.4 dedupes overlapping findings across agents and ranks the merged list", async () => {
    fx = await reviewFixture();
    const llm = new FakeLlm((call) => {
      switch (agentOf(call)) {
        case "logic":
          return {
            findings: [
              finding({}),
              finding({ line: 5, severity: "medium", title: "Tax rounding drift", body: "Rounding per call drifts.", confidence: 3 }),
              finding({ line: 40, title: "Not in diff at all", confidence: 5 }),
            ],
          };
        case "style":
          return {
            findings: [
              finding({ line: 4, severity: "medium", title: "Callers do not pass region argument", confidence: 3 }),
              finding({ line: 1, severity: "low", title: "Unused speculative nit", confidence: 1 }),
            ],
          };
        case "security":
          return { findings: [] };
        default:
          return summaryOut;
      }
    });
    const result = await reviewPullRequest(
      { db: fx.db, llm, embedder: fx.embedder },
      { orgId: "org_a", repoId: fx.repo.id, repoFullName: "acme/shop", prNumber: 7, client: fx.client },
    );
    expect(result.findings.map((f) => [f.line, f.severity, f.title, f.agents])).toEqual([
      [3, "high", "Callers do not pass region", ["logic", "style"]],
      [5, "medium", "Tax rounding drift", ["logic"]],
    ]);
    const summaryCall = llm.calls.find((c) => agentOf(c) === "summary")!;
    expect(summaryCall.req.prompt).toContain("[high] services/billing/pricing.ts:3 Callers do not pass region");
  });

  test("R1.4 a failing reviewer agent does not abort the review", async () => {
    fx = await reviewFixture();
    const llm = new FakeLlm((call) => {
      const a = agentOf(call);
      if (a === "security") throw new Error("upstream timeout");
      if (a === "summary") return summaryOut;
      return { findings: a === "logic" ? [finding({})] : [] };
    });
    const result = await reviewPullRequest(
      { db: fx.db, llm },
      { orgId: "org_a", repoId: fx.repo.id, repoFullName: "acme/shop", prNumber: 7, client: fx.client },
    );
    expect(result.agentRuns.find((r) => r.agent === "security")?.error).toBe("upstream timeout");
    expect(result.findings).toHaveLength(1);
  });

  test("R1.4 ranking anchors findings to commentable lines and keeps only valid multi-line suggestions", () => {
    const d = parsePatch("a.ts", "modified", "@@ -1,3 +1,4 @@\n line1\n-old\n+new2\n+new3\n line4");
    expect([...d.commentable]).toEqual([1, 2, 3, 4]);
    const ranked = rankFindings(
      [
        { agent: "logic", category: "logic", finding: finding({ path: "a.ts", line: 6, title: "snapped", suggestion: "x" }) },
        { agent: "logic", category: "logic", finding: finding({ path: "a.ts", line: 2, endLine: 3, title: "range ok", body: "b1", suggestion: "a\nb", severity: "critical" }) },
        { agent: "style", category: "style", finding: finding({ path: "a.ts", line: 3, endLine: 9, title: "bad span", body: "zzz", suggestion: "q\nr", severity: "low" }) },
        { agent: "style", category: "style", finding: finding({ path: "other.ts", line: 1, title: "not in PR" }) },
      ],
      [d],
      { maxComments: 10 },
    );
    expect(ranked.map((f) => [f.title, f.line, f.endLine, f.suggestion])).toEqual([
      ["range ok", 2, 3, "a\nb"],
      ["snapped", 4, null, "x"],
      ["bad span", 3, null, null],
    ]);
  });
});
