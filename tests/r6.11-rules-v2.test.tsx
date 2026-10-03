import { afterEach, describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleCard } from "@/components/rules/RuleCard";
import { EMPTY_RULE, RuleForm } from "@/components/rules/RuleForm";
import {
  activeRulesForRepo,
  applyRuleTemplate,
  createRule,
  createRulePreviewHandler,
  deleteRule,
  listRules,
  parseRuleForm,
  previewRulePaths,
  reviewCandidateRule,
  ruleFindingCounts,
  RuleValidationError,
  saveRuleForm,
  setRuleEnabled,
  updateRule,
} from "@/lib/data/rules";
import type { Db } from "@/lib/db";
import { files, findings, installations, repos, reviews, rules } from "@/lib/db/schema";
import { runReview } from "@/lib/engine";
import { teamRulesSections } from "@/lib/engine/review-prompt";
import { applySeverityFloor, renderRuleLine, RULE_TEMPLATES, type ReviewRule } from "@/lib/rules";
import { INITIAL_RULE_FORM_STATE } from "@/lib/rules/form-state";
import { NOW, signedInCookie, testAuthConfig, userWithOrg } from "./helpers/auth";
import { candidateAt, engineLlm, engineRequest, judgedFindings, PRICING, verdict } from "./helpers/engine";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";
import { createTestDb } from "./helpers/db";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => {
  fx?.fixture.cleanup();
  fx = undefined;
});

let ext = 50_000;

/** An org (from `userWithOrg`) with one installation and repositories with indexed file paths. */
async function orgWithRepos(db: Db, login: string, repoFiles: Record<string, string[]>) {
  const owner = await userWithOrg(db, { login });
  const [inst] = await db.insert(installations).values({ orgId: owner.org.id, externalId: ++ext, accountLogin: login }).returning();
  const out: Record<string, number> = {};
  for (const [fullName, paths] of Object.entries(repoFiles)) {
    const [repo] = await db.insert(repos).values({ orgId: owner.org.id, installationId: inst!.id, externalId: ++ext, fullName }).returning();
    out[fullName] = repo!.id;
    for (const path of paths) {
      await db.insert(files).values({ orgId: owner.org.id, repoId: repo!.id, path, language: "typescript", contentHash: path });
    }
  }
  return { ...owner, repos: out };
}

function form(values: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

describe("rules v2", () => {
  test("R6.11 rule CRUD stores title, category, severity, instructions, scope, and globs, with validation and tenant isolation", async () => {
    const db = await createTestDb();
    const a = await orgWithRepos(db, "alice", { "acme/api": ["src/api/users.ts"] });
    const b = await orgWithRepos(db, "bob", { "other/x": [] });
    const repoId = a.repos["acme/api"]!;

    const rule = await createRule(db, a.org.id, {
      title: "Check org membership",
      text: "API routes must verify organization membership.",
      category: "security",
      severity: "high",
      instructions: "Session-derived org ids count as a check.",
      repoId,
      paths: ["src/api/**", " ", "src/api/**"],
    });
    expect(rule).toMatchObject({ title: "Check org membership", category: "security", severity: "high", enabled: true, repoId, paths: ["src/api/**"] });

    await expect(createRule(db, a.org.id, { text: "x" })).rejects.toBeInstanceOf(RuleValidationError);
    await expect(createRule(db, a.org.id, { text: "Valid rule text", severity: "urgent" as never })).rejects.toBeInstanceOf(RuleValidationError);
    await expect(createRule(db, a.org.id, { text: "Valid rule text", category: "vibes" as never })).rejects.toBeInstanceOf(RuleValidationError);
    await expect(createRule(db, a.org.id, { text: "Valid rule text", paths: Array.from({ length: 51 }, (_, i) => `p${i}/**`) })).rejects.toBeInstanceOf(RuleValidationError);
    // Another org's repository is not a valid scope; another org's rule cannot be read, changed, or deleted.
    await expect(createRule(db, b.org.id, { text: "Sneaky cross-org rule", repoId })).rejects.toBeInstanceOf(RuleValidationError);
    expect(await updateRule(db, b.org.id, rule.id, { severity: "low" })).toBeUndefined();
    expect(await setRuleEnabled(db, b.org.id, rule.id, false)).toBeUndefined();
    expect(await deleteRule(db, b.org.id, rule.id)).toBe(false);
    expect(await listRules(db, b.org.id)).toEqual([]);

    const updated = await updateRule(db, a.org.id, rule.id, { category: "api_compat", severity: "critical", instructions: "  ", repoId: null });
    expect(updated).toMatchObject({ category: "api_compat", severity: "critical", instructions: "", repoId: null });

    // Filters: scope, repository, category, enabled, status.
    await createRule(db, a.org.id, { title: "Tests", text: "Billing changes need tests.", category: "testing", repoId, enabled: false });
    await createRule(db, a.org.id, { text: "Mined candidate rule.", status: "candidate", source: "mined" });
    const titles = async (f: Parameters<typeof listRules>[2]) => (await listRules(db, a.org.id, f)).map((r) => r.rule.text);
    expect(await titles({ scope: "org", status: ["active"] })).toEqual(["API routes must verify organization membership."]);
    expect(await titles({ scope: "repo" })).toEqual(["Billing changes need tests."]);
    expect(await titles({ repoId })).toEqual(["Billing changes need tests."]);
    expect(await titles({ category: "testing" })).toEqual(["Billing changes need tests."]);
    expect(await titles({ enabled: false })).toEqual(["Billing changes need tests."]);
    expect(await titles({ status: ["candidate"] })).toEqual(["Mined candidate rule."]);
    expect(await deleteRule(db, a.org.id, rule.id)).toBe(true);
  });

  test("R6.11 the rule form validates fields and only owners and admins can save rules", async () => {
    const db = await createTestDb();
    const a = await orgWithRepos(db, "carol", { "acme/web": [] });
    const repoId = a.repos["acme/web"]!;
    const ctx = { orgId: a.org.id, userId: a.user.id };

    const bad = parseRuleForm(form({ title: "", text: "no", category: "nope", severity: "medium", scope: "repo", paths: "" }));
    expect(bad.errors).toMatchObject({ title: expect.any(String), text: expect.any(String), category: "Pick a category." });
    expect(parseRuleForm(form({ title: "Valid title", text: "A valid rule.", scope: "repo", repoId: "" })).errors).toEqual({ repoId: "Pick a repository for a repository rule." });

    expect((await saveRuleForm(db, { ...ctx, role: "member" }, form({ title: "Member rule", text: "Members cannot add this." }))).status).toBe("forbidden");
    const invalid = await saveRuleForm(db, { ...ctx, role: "admin" }, form({ title: "T", text: "short" }));
    expect(invalid.status).toBe("invalid");
    expect(invalid.values).toMatchObject({ title: "T", text: "short" });

    const created = await saveRuleForm(
      db,
      { ...ctx, role: "admin" },
      form({
        title: "Use the repository layer",
        text: "Handlers must not run raw SQL.",
        category: "data",
        severity: "high",
        scope: "repo",
        repoId: String(repoId),
        paths: "src/api/**\n**/*.sql",
        instructions: "ORM query builders are fine.",
        enabled: ["false"],
      }),
    );
    expect(created.status).toBe("saved");
    const [row] = await db.select().from(rules);
    expect(row).toMatchObject({ title: "Use the repository layer", category: "data", severity: "high", repoId, paths: ["src/api/**", "**/*.sql"], enabled: false, createdBy: a.user.id });

    // Editing through the form: back to org-wide, enabled; another org's rule id is not found.
    const edited = await saveRuleForm(db, { ...ctx, role: "owner" }, form({ ruleId: String(row!.id), title: "Use the repository layer", text: "Handlers must not run raw SQL.", scope: "org", enabled: ["true", "false"] }));
    expect(edited.status).toBe("saved");
    expect((await db.select().from(rules))[0]).toMatchObject({ repoId: null, enabled: true });
    const other = await orgWithRepos(db, "dave", {});
    expect((await saveRuleForm(db, { orgId: other.org.id, userId: other.user.id, role: "owner" }, form({ ruleId: String(row!.id), title: "Hijack", text: "Hijacked rule text." }))).status).toBe("not_found");
  });

  test("R6.11 enable/disable controls whether a rule reaches the review engine, with its category, severity, and instructions", async () => {
    const db = await createTestDb();
    const a = await orgWithRepos(db, "erin", { "acme/api": [] });
    const repoId = a.repos["acme/api"]!;
    const sec = await createRule(db, a.org.id, { title: "Membership", text: "Verify org membership.", category: "security", severity: "high", instructions: "Session org ids count." });
    const style = await createRule(db, a.org.id, { text: "No debug logging.", category: "style", severity: "low", repoId });

    expect(await activeRulesForRepo(db, a.org.id, repoId)).toEqual([
      { id: `rule:${sec.id}`, text: "Verify org membership.", paths: [], scope: "org", category: "security", severity: "high", instructions: "Session org ids count." },
      { id: `rule:${style.id}`, text: "No debug logging.", paths: [], scope: "repo", category: "style", severity: "low" },
    ]);
    await setRuleEnabled(db, a.org.id, sec.id, false);
    expect((await activeRulesForRepo(db, a.org.id, repoId)).map((r) => r.id)).toEqual([`rule:${style.id}`]);
    await setRuleEnabled(db, a.org.id, sec.id, true);
    expect((await activeRulesForRepo(db, a.org.id, repoId)).map((r) => r.id)).toEqual([`rule:${sec.id}`, `rule:${style.id}`]);
  });

  test("R6.11 category, severity, and instructions are rendered into the prompt's team rules", () => {
    const rule: ReviewRule = {
      id: "rule:7",
      text: "API routes must\nverify membership.",
      paths: ["app/api/**"],
      scope: "org",
      category: "security",
      severity: "high",
      instructions: "Session-derived ids\ncount as a check.",
    };
    expect(renderRuleLine(rule)).toBe(
      "- [rule:7] (category: security; severity: high; applies to: app/api/**) API routes must verify membership.\n  Instructions: Session-derived ids count as a check.",
    );
    expect(renderRuleLine({ id: "config:1", text: "Plain config rule.", paths: [], scope: "config" })).toBe("- [config:1] Plain config rule.");
    const [section] = teamRulesSections([rule], null, []);
    expect(section).toContain("Use at least the rule's severity for a violation");
    expect(section).toContain("(category: security; severity: high; applies to: app/api/**)");
    expect(section).toContain("Instructions: Session-derived ids count as a check.");
  });

  test("R6.11 a finding citing a rule takes the rule's severity as a floor", async () => {
    expect(applySeverityFloor("low", { severity: "high" })).toBe("high");
    expect(applySeverityFloor("critical", { severity: "medium" })).toBe("critical");
    expect(applySeverityFloor("medium", null)).toBe("medium");
    expect(applySeverityFloor("low", {})).toBe("low");

    fx = await reviewFixture();
    const rule: ReviewRule = { id: "rule:41", text: "Tax must be computed with the shared helper.", paths: ["services/billing/**"], scope: "org", category: "correctness", severity: "high" };
    const llm = engineLlm({
      review: (agent) => ({
        findings:
          agent === "correctness"
            ? [
                candidateAt(HEAD_PRICING, 5, { title: "Tax added without rounding policy", severity: "low", confidence: 0.9, ruleId: "rule:41" }),
                candidateAt(HEAD_PRICING, 4, { title: "Subtotal is recomputed on each call", severity: "low", confidence: 0.9, path: PRICING }),
              ]
            : [],
      }),
      // The judge lowers both to low; the cited rule keeps its finding at high.
      verify: (call) => ({ verdicts: judgedFindings(call).map(({ id }) => verdict(id, { severity: "low", confidence: 0.9 })) }),
    });
    const out = await runReview({ db: fx.db, llm, embedder: fx.embedder }, await engineRequest(fx, { rules: [rule] }));
    const byTitle = Object.fromEntries(out.findings.map((f) => [f.title, f]));
    expect(byTitle["Tax added without rounding policy"]).toMatchObject({ severity: "high", rule: { id: "rule:41" } });
    expect(byTitle["Subtotal is recomputed on each call"]).toMatchObject({ severity: "low", rule: null });
    // The judge already saw the floored severity.
    const judged = llm.calls.filter((c) => c.req.task === "verify").flatMap((c) => judgedFindings(c).map((j) => j.finding));
    expect(judged.find((f) => f.title === "Tax added without rounding policy")?.severity).toBe("high");
  });

  test("R6.11 path-glob preview counts matching indexed files, scoped to the org, behind auth", async () => {
    const db = await createTestDb();
    const a = await orgWithRepos(db, "fran", {
      "acme/api": ["src/api/users.ts", "src/api/orgs.ts", "src/lib/db.ts", "README.md"],
      "acme/web": ["src/api/proxy.ts", "web/app.tsx"],
    });
    const b = await orgWithRepos(db, "gus", { "other/api": ["src/api/secret.ts"] });
    const apiId = a.repos["acme/api"]!;

    expect(await previewRulePaths(db, a.org.id, { repoId: apiId, paths: ["src/api/**"] })).toEqual({ files: 2, repos: 1, sample: ["src/api/orgs.ts", "src/api/users.ts"], capped: false });
    expect((await previewRulePaths(db, a.org.id, { repoId: apiId, paths: ["README.md", "src/lib/*.ts"] })).files).toBe(2);
    expect((await previewRulePaths(db, a.org.id, { repoId: apiId, paths: [] })).files).toBe(4);
    const orgWide = await previewRulePaths(db, a.org.id, { repoId: null, paths: ["src/api/**"] });
    expect(orgWide).toMatchObject({ files: 3, repos: 2 });
    expect(orgWide.sample).toContain("acme/web:src/api/proxy.ts");
    expect(orgWide.sample.join()).not.toContain("secret");
    expect((await previewRulePaths(db, a.org.id, { repoId: apiId, paths: ["src/**"], limit: 1 })).capped).toBe(true);

    const handler = createRulePreviewHandler(() => ({ db, clock: { now: NOW, ttlDays: testAuthConfig.sessionTtlDays } }));
    const url = (q: string) => `${testAuthConfig.appUrl}/api/rules/preview?${q}`;
    expect((await handler(new Request(url("paths=src/**")))).status).toBe(401);
    const ok = await handler(new Request(url(`repoId=${apiId}&paths=${encodeURIComponent("src/api/**")}`), { headers: { cookie: a.cookie } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ files: 2 });
    // Another org's repository is not found for this session.
    const other = await handler(new Request(url(`repoId=${b.repos["other/api"]}&paths=src/**`), { headers: { cookie: a.cookie } }));
    expect(other.status).toBe(404);
    const noOrg = await signedInCookie(db, a.user.id, null);
    expect((await handler(new Request(url("paths=src/**"), { headers: { cookie: noOrg.cookie } }))).status).toBe(403);
  });

  test("R6.11 starter templates add ready rules", async () => {
    const db = await createTestDb();
    const a = await orgWithRepos(db, "hana", { "acme/api": [] });
    expect(RULE_TEMPLATES.map((t) => t.title)).toEqual([
      "API routes must verify organization membership",
      "No direct database calls from React components",
      "Billing changes require tests",
      "No debug logging in production code",
    ]);
    const row = await applyRuleTemplate(db, a.org.id, { templateId: "billing-tests", createdBy: a.user.id });
    expect(row).toMatchObject({ title: "Billing changes require tests", category: "testing", severity: "high", source: "template", status: "active", enabled: true, repoId: null });
    expect(row.paths).toContain("**/billing/**");
    expect(row.instructions).not.toBe("");
    await expect(applyRuleTemplate(db, a.org.id, { templateId: "nope" })).rejects.toBeInstanceOf(RuleValidationError);
  });

  test("R6.11 candidate approval turns a mined rule active (R2.5) and findings from a rule are counted", async () => {
    const db = await createTestDb();
    const a = await orgWithRepos(db, "ivan", { "acme/api": [] });
    const b = await orgWithRepos(db, "jill", {});
    const repoId = a.repos["acme/api"]!;
    const evidence = [{ commentId: 9, author: "maria", excerpt: "Please use integer cents." }];
    const candidate = await createRule(db, a.org.id, { text: "Money is integer cents.", status: "candidate", source: "mined", repoId, evidence });
    const dismissed = await createRule(db, a.org.id, { text: "A mined rule nobody wants.", status: "candidate", source: "mined" });

    expect(await activeRulesForRepo(db, a.org.id, repoId)).toEqual([]);
    expect(await reviewCandidateRule(db, b.org.id, candidate.id, "approve")).toBeUndefined();
    expect(await reviewCandidateRule(db, a.org.id, candidate.id, "approve")).toMatchObject({ status: "active" });
    expect(await reviewCandidateRule(db, a.org.id, candidate.id, "reject")).toBeUndefined(); // no longer a candidate
    expect(await reviewCandidateRule(db, a.org.id, dismissed.id, "reject")).toMatchObject({ status: "rejected" });
    expect((await activeRulesForRepo(db, a.org.id, repoId)).map((r) => r.id)).toEqual([`rule:${candidate.id}`]);

    const [review] = await db.insert(reviews).values({ orgId: a.org.id, repoId, prNumber: 3, headSha: "abc" }).returning();
    const base = { orgId: a.org.id, repoId, reviewId: review!.id, prNumber: 3, severity: "high", confidence: 0.9, category: "rules", agent: "rules", path: "a.ts", startLine: 1, endLine: 1, commitSha: "abc", firstSeenSha: "abc" };
    await db.insert(findings).values([
      { ...base, title: "One", fingerprint: "f1", visibility: "published", ruleId: `rule:${candidate.id}` },
      { ...base, title: "Two", fingerprint: "f2", visibility: "published", ruleId: `rule:${candidate.id}` },
      { ...base, title: "Rejected", fingerprint: "f3", visibility: "rejected", ruleId: `rule:${candidate.id}` },
    ]);
    expect(await ruleFindingCounts(db, a.org.id, [candidate.id, dismissed.id])).toEqual(new Map([[candidate.id, 2]]));
    expect(await ruleFindingCounts(db, b.org.id, [candidate.id])).toEqual(new Map());

    const html = renderToStaticMarkup(
      <RuleCard rule={{ ...candidate, status: "candidate", repoFullName: "acme/api", findings: 2 }} actions={<button type="button">Approve</button>} />,
    );
    expect(html).toContain("Suggested");
    expect(html).toContain("@maria: “Please use integer cents.”");
    expect(html).toContain(`href="/dashboard/findings?rule=rule%3A${candidate.id}"`);
    expect(html).toContain("2 findings from this rule");
  });

  test("R6.11 the rules form renders every field with labels and the live path preview", () => {
    const html = renderToStaticMarkup(
      <RuleForm
        initial={{ ...EMPTY_RULE, ruleId: 5, title: "Membership", text: "Verify membership.", category: "security", severity: "high", paths: ["app/api/**"], repoId: 2 }}
        repos={[{ id: 2, fullName: "acme/api" }]}
        action={async () => INITIAL_RULE_FORM_STATE}
        submitLabel="Save rule"
      />,
    );
    for (const label of [">Title<", ">Rule<", ">Category<", ">Severity<", ">Applies to<", ">File patterns<", "Instructions"]) expect(html).toContain(label);
    expect(html).toContain('name="ruleId" value="5"');
    expect(html).toContain('<option value="security" selected="">Security</option>');
    expect(html).toContain("Findings that cite this rule are at least this severe.");
    expect(html).toContain('data-testid="path-preview"');
    expect(html).toContain("app/api/**</textarea>");
    expect(html).toContain('<option value="2" selected="">acme/api</option>');
    const card = renderToStaticMarkup(
      <RuleCard
        rule={{ id: 3, title: "", text: "Never log tokens. They leak.", category: "style", severity: "low", enabled: false, instructions: "", paths: [], status: "active", source: "dashboard", repoFullName: null, rationale: null, evidence: null, findings: 0 }}
      />,
    );
    expect(card).toContain("Never log tokens.</h3>");
    expect(card).toContain(">Off<");
    expect(card).toContain("All repositories");
  });
});
