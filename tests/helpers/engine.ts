import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_IDS, type EngineSettings, type ReviewRequest } from "@/lib/engine";
import type { Candidate } from "@/lib/engine/agents";
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import type { FixtureRepo } from "./fixture-repo";
import type { reviewFixture } from "./review-fixture";

export type Fixture = Awaited<ReturnType<typeof reviewFixture>>;

export const PRICING = "services/billing/pricing.ts";

export const SETTINGS: EngineSettings = {
  minConfidence: 0.5,
  minSeverity: "low",
  maxComments: 20,
  categories: [...AGENT_IDS],
  ignoredPaths: [],
  customInstructions: null,
  commentStyle: "detailed",
  model: null,
};

/** File content at a commit of the fixture repository, or null when absent. */
export function readAt(fixture: FixtureRepo, sha: string, file: string): string | null {
  try {
    return fixture.git("show", `${sha}:${file}`) + "\n";
  } catch {
    return null;
  }
}

/** A review request for the fixture's PR #7 (base..head), with overridable fields. */
export async function engineRequest(fx: Fixture, over: Partial<ReviewRequest> = {}): Promise<ReviewRequest> {
  const prFiles = await fx.client.listPullRequestFiles("acme/shop", 7);
  return {
    orgId: "org_a",
    repo: { id: fx.repo.id, fullName: "acme/shop", defaultBranch: "main" },
    baseSha: fx.base,
    headSha: fx.head,
    pr: { number: 7, title: fx.pr.title, body: fx.pr.body, author: fx.pr.author, baseRef: "main", headRef: "feature" },
    files: prFiles.map((f) => ({ path: f.path, status: f.status, patch: f.patch })),
    readFile: async (file, ref) => readAt(fx.fixture, ref === "head" ? fx.head : fx.base, file),
    mode: "standard",
    settings: SETTINGS,
    rules: [],
    learned: [],
    contextDocs: [],
    existingComments: [],
    priorFindings: [],
    historicalFindings: [],
    ...over,
  };
}

/** Unified diff hunks (from `@@`) between two versions of a file, as a git host would report them. */
export function patchBetween(before: string | null, after: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "or-patch-"));
  try {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    writeFileSync(a, before ?? "");
    writeFileSync(b, after ?? "");
    let out = "";
    try {
      execFileSync("git", ["diff", "--no-index", "-U3", a, b], { encoding: "utf8" });
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? "";
    }
    return out.slice(out.indexOf("@@"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SUMMARY_OUT = {
  overview: "Adds tax to order totals.",
  whatChanged: ["computeTotal now adds tax and takes a region"],
  affectedAreas: ["billing"],
  riskLevel: "high",
  riskRationale: "Callers were not updated.",
  confidence: 4,
  architectureImpact: null,
};

export interface Handlers {
  classify?: (call: FakeCall) => unknown;
  review?: (agent: string, call: FakeCall) => unknown;
  /** The verification judge (default: accept every candidate as proposed). */
  verify?: (call: FakeCall) => unknown;
  /** The prior-finding resolution check (default: nothing fixed). */
  resolve?: (call: FakeCall) => unknown;
  summary?: (call: FakeCall) => unknown;
}

export const agentOf = (call: FakeCall) => call.req.meta?.agent ?? "";

/** Finding blocks in a judge prompt: id and the JSON the engine wrote. */
export function judgedFindings(call: FakeCall): { id: string; finding: { severity: string; confidence: number; title: string } }[] {
  return [...call.req.prompt.matchAll(/<finding nonce="[0-9a-f]+" id="(c\d+)">\n([\s\S]*?)\n<\/finding nonce=/g)].map((m) => ({ id: m[1]!, finding: JSON.parse(m[2]!) }));
}

const ALL_CHECKS = { grounded: true, codeAccurate: true, introducedByPr: true, actionable: true, nonTrivial: true, notDuplicate: true };

/** A judge that accepts every candidate with its proposed severity and confidence. */
export function acceptAll(call: FakeCall) {
  return {
    verdicts: judgedFindings(call).map(({ id, finding }) => ({ id, verdict: "accept", reasons: ["verified"], severity: finding.severity, confidence: finding.confidence, checks: ALL_CHECKS })),
  };
}

export function verdict(id: string, over: Record<string, unknown> = {}) {
  return { id, verdict: "accept", reasons: ["verified"], severity: "high", confidence: 0.9, checks: ALL_CHECKS, ...over };
}

/** A fake model routed by task and agent (`meta.agent`), with sensible defaults for every engine call. */
export function engineLlm(h: Handlers = {}) {
  return new FakeLlm(async (call) => {
    const agent = agentOf(call);
    switch (call.req.task) {
      case "classify":
        return h.classify ? h.classify(call) : { subsystems: [], riskAreas: [], additionalAgents: [] };
      case "review":
        return h.review ? h.review(agent, call) : { findings: [] };
      case "verify":
        if (agent === "resolver") return h.resolve ? h.resolve(call) : { results: [] };
        return h.verify ? h.verify(call) : acceptAll(call);
      case "summary":
        return h.summary ? h.summary(call) : SUMMARY_OUT;
      default:
        throw new Error(`unexpected task ${call.req.task}`);
    }
  });
}

/** The realistic cross-file bug: computeTotal gained a required parameter its callers do not pass. */
export function callerBug(over: Partial<Candidate> = {}): Candidate {
  return {
    title: "Callers of computeTotal do not pass the new region argument",
    description: "computeTotal now requires a region, but handleCheckout and renderSummary still call it with only the items.",
    impact: "Checkout and the cart summary compile errors or compute totals without a region.",
    severity: "high",
    confidence: 0.9,
    path: PRICING,
    startLine: 3,
    endLine: 3,
    symbol: "computeTotal",
    evidence: [
      { path: PRICING, startLine: 3, endLine: 3, snippet: "export function computeTotal(items: number[], region: string) {", why: "region is a new required parameter" },
      { path: "services/api/handlers.ts", startLine: 4, endLine: 4, snippet: "return { total: computeTotal(req.items) };", why: "handleCheckout passes one argument" },
      { path: "web/cart/summary.ts", startLine: 4, endLine: 4, snippet: 'return "Total: " + computeTotal(items);', why: "renderSummary passes one argument" },
    ],
    suggestedFix: "Pass the account's region from both callers, or give region a default.",
    suggestion: null,
    ruleId: null,
    ...over,
  };
}

/**
 * A candidate anchored to `line` of `content` (the file's head version), citing that line verbatim as its evidence so
 * it passes the engine's grounding checks. `over` sets title, severity, suggestion, ruleId, and the rest.
 */
export function candidateAt(content: string, line: number, over: Partial<Candidate> = {}): Candidate {
  const path = over.path ?? PRICING;
  const endLine = over.endLine ?? line;
  const snippet = content.split("\n").slice(line - 1, endLine).join("\n");
  const title = over.title ?? "Problem";
  return {
    title,
    description: `${title}.`,
    impact: "Wrong totals at checkout.",
    severity: "high",
    confidence: 0.9,
    path,
    startLine: line,
    endLine,
    symbol: null,
    evidence: [{ path, startLine: line, endLine, snippet, why: "the anchored code" }],
    suggestedFix: "",
    suggestion: null,
    ruleId: null,
    ...over,
  };
}

/** Summary model output with the given fields over {@link SUMMARY_OUT}. */
export function summaryOut(over: Partial<typeof SUMMARY_OUT> & { confidence?: number; riskLevel?: string } = {}) {
  return { ...SUMMARY_OUT, ...over };
}

/** Reviewer agents' calls (task `review`), by agent id. */
export const reviewCalls = (llm: { calls: FakeCall[] }) => llm.calls.filter((c) => c.req.task === "review");
