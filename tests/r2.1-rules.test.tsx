import { afterEach, describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RulesList } from "@/components/dashboard/RulesList";
import { completeInstallation } from "@/lib/data/installations";
import { RuleValidationError, activeRulesForRepo, createRule, deleteRule, listRules, updateRule } from "@/lib/data/rules";
import { reviewComments } from "@/lib/db/schema";
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import type { RawFinding } from "@/lib/review/findings";
import { runReviewJob } from "@/lib/review/run";
import { applicableRules, globMatch } from "@/lib/rules";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const agentOf = (call: FakeCall) => /Tracewise's (\w+) reviewer/.exec(call.req.system)?.[1] ?? "summary";
const PRICING = "services/billing/pricing.ts";

describe("custom rules", () => {
  test("R2.1 rules are scoped org-wide or per repo with glob paths", async () => {
    fx = await reviewFixture();
    const { db } = fx;
    fx.host.addInstallation(22, "acme2", [{ id: 9, fullName: "acme/other", defaultBranch: "main", private: true }]);
    const other = (await completeInstallation(db, fx.host, { orgId: "org_a", orgName: "Acme", installationId: 22 })).repos[0]!;

    const orgWide = await createRule(db, "org_a", { text: "Never log access tokens." });
    const billing = await createRule(db, "org_a", { text: "Money math must use integer cents.", repoId: fx.repo.id, paths: ["services/billing/**", " "] });
    await createRule(db, "org_a", { text: "Other repo only rule.", repoId: other.id });
    await createRule(db, "org_a", { text: "Mined but unapproved rule.", status: "candidate", source: "mined" });
    expect(billing.paths).toEqual(["services/billing/**"]);

    const active = await activeRulesForRepo(db, "org_a", fx.repo.id);
    expect(active).toEqual([
      { id: `rule:${orgWide.id}`, text: "Never log access tokens.", paths: [], scope: "org" },
      { id: `rule:${billing.id}`, text: "Money math must use integer cents.", paths: ["services/billing/**"], scope: "repo" },
    ]);
    expect(applicableRules(active, ["web/cart/summary.ts"]).map((r) => r.id)).toEqual([`rule:${orgWide.id}`]);
    expect(applicableRules(active, ["services/billing/tax.ts"])).toHaveLength(2);
    expect(globMatch(["**/*.sql", "src/api/**"], "db/migrations/1.sql")).toBe(true);
    expect(globMatch(["src/api/**"], "src/apix/a.ts")).toBe(false);
  });

  test("R2.1 rule management is tenant-isolated and validated", async () => {
    fx = await reviewFixture();
    const { db } = fx;
    const r = await createRule(db, "org_a", { text: "Prefer early returns." });
    await expect(createRule(db, "org_b", { text: "Sneaky cross-org rule", repoId: fx.repo.id })).rejects.toBeInstanceOf(RuleValidationError);
    await expect(createRule(db, "org_a", { text: "x" })).rejects.toBeInstanceOf(RuleValidationError);
    expect(await updateRule(db, "org_b", r.id, { text: "Hijacked rule text" })).toBeUndefined();
    expect(await deleteRule(db, "org_b", r.id)).toBe(false);
    expect((await updateRule(db, "org_a", r.id, { text: "Prefer early returns over nesting.", paths: ["src/**"] }))?.paths).toEqual(["src/**"]);
    expect((await listRules(db, "org_a")).map((x) => x.rule.text)).toEqual(["Prefer early returns over nesting."]);
    expect(await listRules(db, "org_b")).toEqual([]);
    expect(await deleteRule(db, "org_a", r.id)).toBe(true);
  });

  test("R2.1 applicable rules are injected into review prompts and cited in comments that enforce them", async () => {
    fx = await reviewFixture();
    const { db } = fx;
    const cents = await createRule(db, "org_a", { text: "Money math must use integer cents, never floats.", repoId: fx.repo.id, paths: ["services/billing/**"] });
    const web = await createRule(db, "org_a", { text: "UI strings must be localized.", paths: ["web/**"] });
    const logs = await createRule(db, "org_a", { text: "Every exported function needs a doc comment." });

    const finding = (over: Partial<RawFinding>): RawFinding => ({
      path: PRICING, line: 5, endLine: null, severity: "medium", title: "t", body: "b", suggestion: null, confidence: 4, ...over,
    });
    const llm = new FakeLlm((call) => {
      if (agentOf(call) === "summary") return { whatChanged: ["x"], riskLevel: "low", riskRationale: "r", confidence: 4 };
      if (agentOf(call) !== "logic") return { findings: [] };
      return {
        findings: [
          finding({ title: "Tax computed with float multiplication", body: "0.2 * amount yields fractional cents.", ruleId: `[rule:${cents.id}]` }),
          finding({ line: 3, title: "Exported function lacks documentation", body: "No doc comment on computeTotal.", ruleId: `rule:${logs.id}` }),
          finding({ line: 4, title: "Strings not localized here", body: "Claims a web rule on a billing file.", ruleId: `rule:${web.id}` }),
        ],
      };
    });
    await runReviewJob({ db, host: fx.host, llm, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });

    const prompt = llm.calls.find((c) => agentOf(c) === "logic")!.req.prompt;
    expect(prompt).toContain("## Team rules");
    expect(prompt).toContain(`- [rule:${cents.id}] (applies to: services/billing/**) Money math must use integer cents, never floats.`);
    expect(prompt).toContain(`- [rule:${logs.id}] Every exported function needs a doc comment.`);
    expect(prompt).not.toContain("UI strings must be localized");

    const comments = fx.host.reviews[0]!.comments;
    const byLine = (l: number) => comments.find((c) => c.line === l)!.body;
    expect(byLine(5)).toContain(`**Rule** (\`rule:${cents.id}\`): Money math must use integer cents, never floats.`);
    expect(byLine(3)).toContain(`**Rule** (\`rule:${logs.id}\`)`);
    expect(byLine(4)).not.toContain("**Rule**");
    const stored = await db.select({ line: reviewComments.line, ruleId: reviewComments.ruleId }).from(reviewComments);
    expect(stored.sort((a, b) => a.line - b.line)).toEqual([
      { line: 3, ruleId: `rule:${logs.id}` },
      { line: 4, ruleId: null },
      { line: 5, ruleId: `rule:${cents.id}` },
    ]);
  });

  test("R2.1 the rules page lists each rule's scope", () => {
    const html = renderToStaticMarkup(
      <RulesList
        empty="none"
        rules={[
          { id: 1, text: "No raw SQL in handlers.", paths: ["src/api/**"], status: "active", source: "dashboard", repoFullName: "acme/shop", rationale: null, evidence: null },
          { id: 2, text: "Never log tokens.", paths: [], status: "active", source: "dashboard", repoFullName: null, rationale: null, evidence: null },
        ]}
      />,
    );
    expect(html).toContain('badge badge-muted">acme/shop</span><span class="mono dim">src/api/**</span>');
    expect(html).toContain('badge badge-muted">All repositories</span><span class="dim">all files</span>');
    expect(renderToStaticMarkup(<RulesList rules={[]} empty="No rules yet." />)).toContain("No rules yet.");
  });
});
