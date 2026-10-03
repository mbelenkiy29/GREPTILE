import { afterEach, describe, expect, test } from "vitest";
import { getRepo, updateRepoSettings } from "@/lib/data/installations";
import { createRule } from "@/lib/data/rules";
import { parseRepoConfig, resolveConfig } from "@/lib/config/repo-config";
import type { Candidate } from "@/lib/engine";
import { runReviewJob } from "@/lib/review/run";
import { candidateAt, engineLlm, reviewCalls } from "./helpers/engine";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const f = (line: number, severity: Candidate["severity"], title: string, over: Partial<Candidate> = {}): Candidate =>
  candidateAt(HEAD_PRICING, line, { severity, title, description: `${title}.`, confidence: 0.85, ...over });

/** The real engine over a fake model; every reviewer agent that runs reports `findings`. */
function recordingLlm(findings: Candidate[]) {
  return engineLlm({ review: () => ({ findings }) });
}

const agents = (llm: ReturnType<typeof recordingLlm>) => reviewCalls(llm).map((c) => c.req.meta?.agent);

const CONFIG = JSON.stringify({
  $schema: "https://openreview.dev/schema/openreview.json",
  rules: ["Totals must be computed in integer cents.", { rule: "Generated code must not be edited by hand.", paths: ["**/generated/**"] }],
  ignore: ["**/generated/**"],
  strictness: "low",
  commentTypes: ["logic"],
});

describe("openreview.json", () => {
  test("R2.2 the config file is validated with readable errors", () => {
    expect(parseRepoConfig(CONFIG).config).toMatchObject({ strictness: "low", commentTypes: ["logic"] });
    expect(parseRepoConfig("{ nope").error).toMatch(/^openreview.json is not valid JSON/);
    expect(parseRepoConfig(JSON.stringify({ strictnes: "low" })).error).toMatch(/^openreview.json: \(root\): Unrecognized key/);
    expect(parseRepoConfig(JSON.stringify({ commentTypes: ["perf"] })).error).toMatch(/^openreview.json: commentTypes.0:/);
    expect(parseRepoConfig(JSON.stringify({ rules: [{ rule: "Short", paths: [""] }] })).error).toMatch(/rules.0/);
  });

  test("R2.2 the repo file overrides dashboard settings key by key", () => {
    const dashboard = { strictness: "high" as const, commentTypes: ["security" as const], ignore: ["dist/**"] };
    const resolved = resolveConfig(dashboard, { strictness: "low" });
    expect(resolved).toMatchObject({
      strictness: "low",
      commentTypes: ["security"],
      ignore: ["dist/**"],
      sources: { strictness: "file", commentTypes: "dashboard", ignore: "dashboard" },
    });
    expect(resolveConfig(undefined, undefined)).toMatchObject({
      strictness: "medium",
      commentTypes: ["logic", "security", "style"],
      sources: { strictness: "default", commentTypes: "default", ignore: "default" },
    });
    expect(resolveConfig({}, { rules: ["Use integer cents everywhere.", { rule: "No edits to vendored code.", paths: ["vendor/**"] }] }).rules).toEqual([
      { id: "config:1", text: "Use integer cents everywhere.", paths: [], scope: "config" },
      { id: "config:2", text: "No edits to vendored code.", paths: ["vendor/**"], scope: "config" },
    ]);
  });

  test("R2.2 a review applies the file's rules, ignore paths, strictness, and comment types over the dashboard", async () => {
    fx = await reviewFixture({
      baseExtra: { "openreview.json": CONFIG },
      headExtra: { "services/billing/generated/rates.ts": "export const RATE = 0.2;\n" },
    });
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { strictness: "high", commentTypes: ["logic", "security", "style"] });
    await createRule(fx.db, "org_a", { text: "Dashboard rule still applies." });

    const llm = recordingLlm([
      f(5, "high", "Float tax math", { ruleId: "config:1" }),
      f(3, "low", "Naming nit"),
      f(4, "medium", "Speculative concern", { confidence: 0.6 }),
    ]);
    await runReviewJob({ db: fx.db, host: fx.host, llm, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });

    // commentTypes ["logic"] from the file: only the correctness reviewer runs (the rules reviewer is disabled).
    expect(agents(llm)).toEqual(["correctness"]);
    const prompt = reviewCalls(llm)[0]!.req.prompt;
    expect(prompt).toContain("- [config:1] Totals must be computed in integer cents.");
    expect(prompt).toContain("Dashboard rule still applies.");
    // Ignored path: the generated file is not reviewed, so its path-scoped rule is not in scope either.
    expect(prompt).not.toContain("services/billing/generated/rates.ts");
    expect(prompt).not.toContain("Generated code must not be edited by hand.");

    // strictness "low" keeps only medium+ findings with confidence >= 0.8.
    const posted = fx.host.reviews[0]!.comments;
    expect(posted.map((c) => c.line)).toEqual([5]);
    expect(posted[0]!.body).toContain("**Rule** (`config:1`): Totals must be computed in integer cents.");
  });

  test("R2.2 dashboard settings apply when there is no file, and an invalid file is reported and ignored", async () => {
    fx = await reviewFixture({ baseExtra: { "openreview.json": '{"strictness": "extreme"}' } });
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { commentTypes: ["style"] });
    expect((await getRepo(fx.db, "org_a", fx.repo.id))?.settings).toEqual({ commentTypes: ["style"] });
    expect(await updateRepoSettings(fx.db, "org_b", fx.repo.id, { commentTypes: ["logic"] })).toBeUndefined();
    await expect(updateRepoSettings(fx.db, "org_a", fx.repo.id, { strictness: "extreme" as never })).rejects.toThrow();

    // commentTypes ["style"] from the dashboard maps to the team-rules reviewer, which runs when a rule applies.
    const rule = await createRule(fx.db, "org_a", { text: "Name money values with their unit." });
    const llm = recordingLlm([f(5, "low", "Low but allowed at medium strictness", { confidence: 0.5, ruleId: `rule:${rule.id}` })]);
    await runReviewJob({ db: fx.db, host: fx.host, llm, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    expect(agents(llm)).toEqual(["rules"]);
    const summary = fx.host.issueComments.get("acme/shop#7")![0]!.body;
    expect(summary).toContain('> **Note:** openreview.json: strictness: Invalid option: expected one of "low"|"medium"|"high". Using dashboard settings instead.');
    expect(fx.host.reviews[0]!.comments).toHaveLength(1);
  });
});
