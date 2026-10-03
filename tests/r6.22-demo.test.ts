/**
 * `pnpm demo` in-process (R6.22): with demo mode on and the offline recording, the walkthrough creates the demo org,
 * a local installation, the fixture repository, indexes it, opens a local pull request with a cross-file bug, and runs
 * the real pipeline; the dashboard data and the local pull request page show the posted finding.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { authAccounts, findings, memberships, modelCalls } from "@/lib/db/schema";
import { listReviewPage, getReviewDetail } from "@/lib/data/reviews";
import { LocalModeDisabledError } from "@/lib/git/local/guard";
import { getLocalPullRequestView } from "@/lib/git/local/view";
import { createGateway, PostgresModelCallRecorder } from "@/lib/llm";
import { FakeEmbeddings } from "@/lib/llm/fake";
import { loadRecording, ReplayLlm } from "@/lib/llm/replay";
import { DEMO_FIXTURE_DIR, LOCAL_DEMO_ORG_ID, loadScenario, runLocalDemo, type LocalDemoDeps } from "@/lib/local-demo";
import { createTestDb } from "./helpers/db";
import { tempDir } from "./helpers/fixture-repo";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function demoDeps(over: Partial<LocalDemoDeps> = {}) {
  const db = await createTestDb();
  const root = tempDir("or-demo-git-");
  const cacheDir = tempDir("or-demo-cache-");
  dirs.push(root, cacheDir);
  const replay = new ReplayLlm(await loadRecording(path.join(DEMO_FIXTURE_DIR, "recorded", "review.json")));
  const llm = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: replay, recorder: new PostgresModelCallRecorder(db) });
  const deps: LocalDemoDeps = {
    db,
    mode: { NODE_ENV: "development", DEMO_MODE: true, DEMO_MODE_ALLOW_PRODUCTION: false, LOCAL_GIT_ROOT: root },
    llm,
    embedder: new FakeEmbeddings(),
    cacheDir,
    appUrl: "http://localhost:3000",
    ...over,
  };
  return { deps, db, replay };
}

describe("pnpm demo (R6.22)", () => {
  test("R6.22 the demo creates the org, local repo, and PR, runs the real pipeline offline, and the dashboard shows the finding", async () => {
    const { deps, db, replay } = await demoDeps();
    const scenario = await loadScenario();
    const progress: string[] = [];
    const result = await runLocalDemo({ ...deps, progress: (m) => progress.push(m) });

    expect(result).toMatchObject({ orgId: LOCAL_DEMO_ORG_ID, repository: "demo/payments-service", prNumber: 1, branch: "discount-cap", reusedRepository: false });
    expect(result.run).toMatchObject({ status: "completed", findings: 1, posted: 1 });
    expect(result.reviewUrl).toMatch(/^http:\/\/localhost:3000\/dashboard\/reviews\/\d+$/);
    expect(result.pullRequestUrl).toBe(`http://localhost:3000/dashboard/local/pr/${result.localPullRequestId}`);
    expect(progress.join("\n")).toContain("Indexed");
    // Every recorded answer was used: the walkthrough really ran the classifier, reviewers, verifier, and summarizer.
    expect(replay.unused()).toEqual([]);
    expect(replay.served.map((s) => s.key)).toEqual(expect.arrayContaining(["review:correctness", "verify:verifier", "summary:summarizer"]));
    // The caller of the changed function reached the reviewers from the index although it is outside the diff.
    const reviewerPrompt = replay.served.find((s) => s.key === "review:correctness")!.prompt;
    expect(reviewerPrompt).toContain("src/billing/invoices.ts");
    expect(reviewerPrompt).toContain("applyDiscount(subtotal, coupon.percentOff)");

    // The finding is stored and linked to its inline comment on the local host.
    const [finding] = await db.select().from(findings).where(eq(findings.visibility, "published"));
    expect(finding).toMatchObject({ orgId: LOCAL_DEMO_ORG_ID, path: scenario.bug.path, startLine: scenario.bug.line, severity: "critical", status: "open" });
    expect((finding!.evidence as { path: string }[]).map((e) => e.path)).toContain(scenario.bug.caller.path);

    // Dashboard data: the review list and detail show the local review like any other.
    const page = await listReviewPage(db, LOCAL_DEMO_ORG_ID);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ repoFullName: "demo/payments-service", prNumber: 1, provider: "local" });
    const reviewId = Number(result.reviewUrl.split("/").pop());
    const detail = await getReviewDetail(db, LOCAL_DEMO_ORG_ID, reviewId);
    expect(detail).toMatchObject({ provider: "local", status: "completed", prTitle: scenario.pullRequest.title });
    expect(detail!.findings.items.map((f) => f.title)).toEqual([finding!.title]);
    expect(detail!.summary).toContain("New DEFAULT_MAX_PERCENT_OFF constant (30)");

    // The local pull request page renders the diff with the inline comment thread and the summary comment.
    const view = await getLocalPullRequestView(db, LOCAL_DEMO_ORG_ID, result.localPullRequestId, deps.mode.LOCAL_GIT_ROOT);
    expect(view!.files.map((f) => f.path).sort()).toEqual(["src/billing/pricing.ts", "test/pricing.test.ts"]);
    const thread = view!.files.find((f) => f.path === scenario.bug.path)!.threads[0]!;
    expect(thread.root).toMatchObject({ line: scenario.bug.line, author: "openreview[bot]", id: finding!.externalCommentId });
    expect(thread.root.body).toContain("```suggestion");
    expect(view!.conversation.map((c) => c.body).join("\n")).toContain("<!-- openreview:summary -->");

    // Model calls were recorded, unpriced (scripted responses carry no model).
    const calls = await db.select().from(modelCalls).where(eq(modelCalls.orgId, LOCAL_DEMO_ORG_ID));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.costUsd === null)).toBe(true);

    // The dev-login user can open the demo org.
    const [dev] = await db.select().from(authAccounts).where(eq(authAccounts.provider, "dev"));
    const seats = await db.select().from(memberships).where(eq(memberships.userId, dev!.userId));
    expect(seats).toEqual([expect.objectContaining({ orgId: LOCAL_DEMO_ORG_ID, role: "owner" })]);
  });

  test("R6.22 running the demo again reuses the repository and opens a new pull request", async () => {
    const { deps } = await demoDeps();
    await runLocalDemo(deps);
    const replay = new ReplayLlm(await loadRecording(path.join(DEMO_FIXTURE_DIR, "recorded", "review.json")));
    const second = await runLocalDemo({ ...deps, llm: createGateway({ env: { LLM_PROVIDER: "fake" }, provider: replay }) });
    expect(second).toMatchObject({ reusedRepository: true, prNumber: 2, branch: "discount-cap-2" });
    expect(second.run).toMatchObject({ status: "completed", findings: 1 });
  });

  test("R6.22 the demo refuses to run outside demo mode and in production", async () => {
    const { deps } = await demoDeps();
    await expect(runLocalDemo({ ...deps, mode: { ...deps.mode, DEMO_MODE: false } })).rejects.toThrow(LocalModeDisabledError);
    await expect(runLocalDemo({ ...deps, mode: { ...deps.mode, NODE_ENV: "production" } })).rejects.toThrow(/refused when NODE_ENV=production/);
  });
});
