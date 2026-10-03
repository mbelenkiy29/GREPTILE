import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeEmbeddings } from "@/lib/llm/fake";
import { cliReviewJsonSchema } from "@/packages/cli/src/render";
import { cli, testIo } from "./helpers/cli";
import { callerBug, engineLlm, reviewCalls } from "./helpers/engine";
import { FixtureRepo } from "./helpers/fixture-repo";
import { BASE_FILES, HEAD_PRICING } from "./helpers/review-fixture";

/** A clone of acme/shop on branch `feature`, whose change to computeTotal breaks two callers in other files. */
function shopCheckout() {
  const fixture = new FixtureRepo();
  fixture.commit(BASE_FILES, "base");
  fixture.git("remote", "add", "origin", "git@github.com:acme/shop.git");
  fixture.git("checkout", "--quiet", "-b", "feature");
  fixture.commit({ "services/billing/pricing.ts": HEAD_PRICING }, "add tax");
  return fixture;
}

function modelThatFindsTheCallerBug() {
  return engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug()] : [] }) });
}

describe("openreview review --local (R3.5)", () => {
  let fixture: FixtureRepo;
  beforeAll(() => {
    fixture = shopCheckout();
  });
  afterAll(() => fixture.cleanup());

  test("R3.5 review --local indexes the working tree into PGlite, gives the engine cross-file context, and --json validates against the schema", async () => {
    const llm = modelThatFindsTheCallerBug();
    const io = testIo({ cwd: path.join(fixture.dir, "services"), local: { llm, embedder: new FakeEmbeddings() } });
    const res = await cli(io, "review", "--local", "--json");
    expect(res.err).not.toContain("error:");
    expect(res.code).toBe(0);
    const out = cliReviewJsonSchema.parse(JSON.parse(res.out));
    expect(out).toMatchObject({
      version: 1,
      source: "local",
      repository: { id: null, fullName: "acme/shop" },
      baseRef: "main",
      headRef: "feature",
      mode: "standard",
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      failOn: null,
      exitCode: 0,
      truncated: 0,
    });
    expect(out.headSha).toBe(fixture.git("rev-parse", "HEAD"));
    expect(out.baseSha).toBe(fixture.git("rev-parse", "main"));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ path: "services/billing/pricing.ts", startLine: 3, severity: "high", category: "correctness" });

    // Only the changed file was sent as the diff; the callers reached the model as retrieved context from the index.
    const prompt = reviewCalls(llm).find((c) => c.req.meta?.agent === "correctness")!.req.prompt;
    expect(prompt).toContain("services/billing/pricing.ts");
    expect(prompt).toContain("handleCheckout");
    expect(prompt).toContain("renderSummary");

    // The index lives in .openreview/ (ignored by git) and is reused incrementally.
    expect(readFileSync(path.join(fixture.dir, ".git", "info", "exclude"), "utf8")).toContain("/.openreview/");
    expect(fixture.git("status", "--porcelain")).toBe("");
    // --json keeps stderr free of progress chatter.
    expect(io.err).toBe("");
    const again = testIo({ cwd: fixture.dir, local: { llm: modelThatFindsTheCallerBug(), embedder: new FakeEmbeddings() } });
    const second = await cli(again, "review", "--local");
    expect(second.code).toBe(0);
    expect(again.err).toContain("Updating the local index");
    expect(again.err).toMatch(/Indexed \d+ files \(0 updated, 0 removed\)/);
  });

  test("R3.5 review --agent prints one path:line block per finding and a Fix-all checklist; --fail-on sets the exit code", async () => {
    const agentIo = testIo({ cwd: fixture.dir, local: { llm: modelThatFindsTheCallerBug(), embedder: null } });
    const agent = await cli(agentIo, "review", "--local", "--agent", "--fail-on", "high");
    expect(agent.code).toBe(1);
    expect(agent.out).toContain("# OpenReview: 1 finding (1 high) in acme/shop");
    expect(agent.out).toContain("## 1. services/billing/pricing.ts:3\nseverity: high · category: correctness\ntitle: Callers of computeTotal do not pass the new region argument");
    expect(agent.out).toMatch(/\nwhy: computeTotal now requires a region/);
    expect(agent.out).toContain("fix: Pass the account's region from both callers, or give region a default.");
    expect(agent.out).toContain("## Fix all\n- [ ] services/billing/pricing.ts:3 — [high] Callers of computeTotal do not pass the new region argument");
    // Agent output is quiet on stderr apart from errors.
    expect(agent.err).toBe("");

    const critical = await cli(testIo({ cwd: fixture.dir, local: { llm: modelThatFindsTheCallerBug(), embedder: null } }), "review", "--local", "--json", "--fail-on", "critical");
    expect(critical.code).toBe(0);
    expect(JSON.parse(critical.out)).toMatchObject({ failOn: "critical", exitCode: 0 });

    const human = await cli(testIo({ cwd: fixture.dir, local: { llm: modelThatFindsTheCallerBug(), embedder: null } }), "review", "--local", "--max-findings", "1");
    expect(human.code).toBe(0);
    expect(human.out).toContain("1. [HIGH] Callers of computeTotal do not pass the new region argument");
    expect(human.out).toContain("services/billing/pricing.ts:3 · correctness · confidence 90%");
    // A code frame of the head version, with the finding's line marked.
    expect(human.out).toContain("> 3 │ export function computeTotal(items: number[], region: string) {");
    expect(human.out).toContain("Risk: high — Callers were not updated.");
  });

  test("R3.5 review --include-uncommitted reviews staged, unstaged, and untracked changes; without it they are left out", async () => {
    const repo = shopCheckout();
    writeFileSync(path.join(repo.dir, "services/billing/tax.ts"), "export function taxFor(amount: number) {\n  return Math.round(amount * 0.25);\n}\n");
    writeFileSync(path.join(repo.dir, "services/billing/notes.ts"), "export const NOTE = 'draft';\n");
    const seen = (llm: ReturnType<typeof engineLlm>) => reviewCalls(llm).map((c) => c.req.prompt).join("\n");

    const committed = engineLlm();
    const res = await cli(testIo({ cwd: repo.dir, local: { llm: committed, embedder: null } }), "review", "--local", "--json");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out).headSha).toBe(repo.git("rev-parse", "HEAD"));
    expect(seen(committed)).not.toContain("amount * 0.25");

    const dirty = engineLlm();
    const res2 = await cli(testIo({ cwd: repo.dir, local: { llm: dirty, embedder: null } }), "review", "--local", "--json", "--include-uncommitted");
    expect(res2.code).toBe(0);
    expect(JSON.parse(res2.out).headSha).toBe(`${repo.git("rev-parse", "HEAD")}+dirty`);
    expect(seen(dirty)).toContain("amount * 0.25");
    expect(seen(dirty)).toContain("services/billing/notes.ts");
    repo.cleanup();
  });

  test("R3.5 review gives helpful errors: no model configured, not a git repository, no base branch, nothing to review", async () => {
    // No model in the environment and not logged in.
    const noModel = await cli(testIo({ cwd: fixture.dir }), "review");
    expect(noModel.code).toBe(2);
    expect(noModel.err).toContain("Not logged in to a server: reviewing locally.");
    expect(noModel.err).toContain("No model is configured for local reviews");
    expect(noModel.err).toContain("Set ANTHROPIC_API_KEY (or LLM_PROVIDER and LLM_API_KEY), or run `openreview login` to review on your server.");

    const fake = await cli(testIo({ cwd: fixture.dir, env: { LLM_PROVIDER: "fake" } }), "review", "--local");
    expect(fake.err).toContain("LLM_PROVIDER=fake is for tests");

    // A model that fails every call must not look like a clean review.
    const failing = engineLlm({
      review: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:443");
      },
    });
    const down = await cli(testIo({ cwd: fixture.dir, local: { llm: failing, embedder: null } }), "review", "--local", "--json");
    expect(down.code).toBe(2);
    expect(down.out).toBe("");
    expect(down.err).toContain("error: The review model failed: Every review model call failed");
    expect(down.err).toContain("Check your model settings");

    const notGit = await cli(testIo({ cwd: mkdtempSync(path.join(tmpdir(), "or-not-git-")) }), "review", "--local");
    expect(notGit.code).toBe(2);
    expect(notGit.err).toContain("error: This is not a git repository.\nRun openreview inside your project's git checkout.");

    const trunk = new FixtureRepo("trunk");
    trunk.commit({ "a.ts": "export const a = 1;\n" });
    const noBase = await cli(testIo({ cwd: trunk.dir }), "review", "--local");
    expect(noBase.code).toBe(2);
    expect(noBase.err).toContain("Couldn't find the base branch to compare against");
    expect(noBase.err).toContain("--base develop");
    const unknownBase = await cli(testIo({ cwd: trunk.dir }), "review", "--local", "--base", "nope");
    expect(unknownBase.err).toContain('The base "nope" is not a branch, tag, or commit in this repository.');

    // Reviewing the base branch itself: nothing to review (exit 0, valid JSON).
    const same = await cli(testIo({ cwd: trunk.dir }), "review", "--local", "--base", "trunk", "--json");
    expect(same.code).toBe(0);
    expect(cliReviewJsonSchema.parse(JSON.parse(same.out))).toMatchObject({ findings: [], summary: { overview: "No changes to review." } });
    trunk.cleanup();

    const usage = await cli(testIo({ cwd: fixture.dir }), "review", "--mode", "ultra");
    expect(usage.code).toBe(2);
    expect(usage.err).toContain("Allowed choices are fast, standard, deep");
    const help = await cli(testIo({ cwd: fixture.dir }), "review", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("$ openreview review --json --fail-on high");
  });
});
