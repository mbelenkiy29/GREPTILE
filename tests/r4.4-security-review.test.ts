import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { renderFindingMarkdown, renderSummaryMarkdown, runReview } from "@/lib/engine";
import { agentOf, callerBug, engineLlm, engineRequest, patchBetween, type Fixture } from "./helpers/engine";
import { reviewFixture } from "./helpers/review-fixture";

// Built at runtime so no source file holds a contiguous provider-key literal.
const SECRET = ["sk", "live", "51Hx9QaZ3kLmN8pQrStUvWxYz0123456789"].join("_");
const CLIENT = "services/billing/stripe.ts";

let fx: Fixture;
beforeAll(async () => {
  fx = await reviewFixture({
    baseExtra: { "package.json": `{\n  "name": "shop",\n  "dependencies": {\n    "zod": "^3.0.0"\n  }\n}\n` },
    headExtra: {
      [CLIENT]: `export const stripeKey = "${SECRET}";\n\nexport async function refund(orgId: string, chargeId: string, url: string) {\n  return fetch(url + "/refunds/" + chargeId, { method: "POST" });\n}\n`,
      "package.json": `{\n  "name": "shop",\n  "dependencies": {\n    "zod": "^3.0.0",\n    "left-padd": "^1.0.0"\n  }\n}\n`,
    },
  });
});
afterAll(() => fx.fixture.cleanup());

describe("security review mode", () => {
  test("R4.4 security focus runs the dedicated profile: deep security agent with the checklist plus security-relevant correctness", async () => {
    const llm = engineLlm();
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx, { focus: "security", mode: "standard" }));
    const reviews = llm.calls.filter((c) => c.req.task === "review");
    expect(reviews.map((c) => [agentOf(c), c.req.mode]).sort()).toEqual([
      ["correctness", "standard"],
      ["security", "deep"],
    ]);
    const security = reviews.find((c) => agentOf(c) === "security")!.req.system;
    for (const item of ["Injection", "Authorization gaps", "organization/tenant", "Secrets", "Unsafe deserialization", "SSRF", "Path traversal", "Insecure redirects", "Sensitive logging", "Dependency risks"]) {
      expect(security).toContain(item);
    }
    expect(reviews.find((c) => agentOf(c) === "correctness")!.req.system).toContain("This is a security review: report only logic errors that have security consequences");
    expect(out.classification.agents.map((a) => a.id)).toEqual(["security", "correctness"]);
    expect(out.classification.skippedAgents.map((s) => s.reason)).toEqual(Array(5).fill("security review runs only the security profile"));
    expect(out.metadata.focus).toBe("security");
    // No classifier call: the profile is fixed.
    expect(llm.calls.some((c) => c.req.task === "classify")).toBe(false);
  });

  test("R4.4 secrets in the diff are detected deterministically and never sent to a model; dependency risks are surfaced", async () => {
    const llm = engineLlm({
      review: (agent) => ({
        findings:
          agent === "security"
            ? [
                callerBug({
                  title: "Live Stripe key committed to source",
                  description: "A live secret key is hard-coded in the billing client.",
                  severity: "critical",
                  confidence: 0.97,
                  path: CLIENT,
                  startLine: 1,
                  endLine: 1,
                  symbol: "stripeKey",
                  evidence: [{ path: CLIENT, startLine: 1, endLine: 1, snippet: "[REDACTED SECRET]", why: "secret scan hit" }],
                  suggestedFix: "Load the key from the environment and rotate it.",
                }),
              ]
            : [],
      }),
    });
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx, { focus: "security" }));
    for (const c of llm.calls) {
      expect(c.req.prompt).not.toContain(SECRET);
      expect(c.req.system).not.toContain(SECRET);
    }
    const prompt = llm.calls.find((c) => agentOf(c) === "security")!.req.prompt;
    expect(prompt).toMatch(new RegExp(`<secret_scan nonce="[0-9a-f]+">\\n[^<]*- ${CLIENT}:1 stripe_key \\(sk_l…\\(\\d+ chars\\)\\)`));
    expect(prompt).toContain("1 + [REDACTED SECRET]");
    expect(out.classification.riskAreas).toEqual(expect.arrayContaining(["secrets", "dependencies"]));
    expect(out.classification.dependencyImpact).toContain("package.json: left-padd added (^1.0.0)");
    expect(prompt).toContain("package.json: left-padd added (^1.0.0)");

    const [f] = out.findings;
    expect(f).toMatchObject({ title: "Live Stripe key committed to source", category: "security", severity: "critical", anchorCode: "[REDACTED SECRET]" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(renderFindingMarkdown(f!)).not.toContain(SECRET);
    const md = renderSummaryMarkdown(out);
    expect(md).toContain("## OpenReview security review");
    expect(md).toContain("standard mode · security focus");
    expect(out.summary.confidence).toBeLessThanOrEqual(3);
    expect(llm.calls.find((c) => c.req.task === "summary")!.req.prompt).toContain("This is a dedicated security review");
  });
  test("R4.4 a multi-line private key added to a source file never reaches any model prompt", async () => {
    const body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "q9Zf3kLmN8pQrStUvWxYz0123456789abcdefGHIJKLmnopQRSTuv", "Xy7Wv6Ut5Sr4Qp3On2Ml1Kk0Jj9Ii8Hh7Gg6Ff5Ee4Dd3Cc2Bb1Aa0"];
    const pem = (edge: string) => `-----${edge} ${"PRIVATE"} KEY-----`;
    const keyFile = `export const signingKey = \`\n${pem("BEGIN")}\n${body.join("\n")}\n${pem("END")}\n\`;\n\nexport function sign(data: string) {\n  return data + signingKey.length;\n}\n`;
    const req = await engineRequest(fx);
    const llm = engineLlm();
    const out = await runReview(
      { db: fx.db, llm },
      {
        ...req,
        files: [...req.files, { path: "src/key.ts", status: "added", patch: patchBetween(null, keyFile) }],
        readFile: async (file, ref) => (file === "src/key.ts" ? (ref === "head" ? keyFile : null) : req.readFile(file, ref)),
      },
    );
    expect(llm.calls.some((c) => c.req.task === "review")).toBe(true);
    const sent = llm.calls.map((c) => `${c.req.system}\n${c.req.prompt}`).join("\n");
    expect(sent).toContain("src/key.ts");
    for (const line of body) expect(sent).not.toContain(line);
    expect(sent).not.toContain("BEGIN PRIVATE KEY");
    for (const line of body) expect(JSON.stringify(out)).not.toContain(line);
  });
});
