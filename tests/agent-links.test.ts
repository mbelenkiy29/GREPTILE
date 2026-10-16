import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLinks, agentRepoContext, codexPromptCap } from "../src/agent-links";
import { fixPrompt } from "../src/fix-prompt";
import type { Finding } from "../src/engine/types";

const finding = { title: "Totals become dollars", description: "total() divides cents by 100.", severity: "high", confidence: 0.93, category: "correctness", filePath: "src/cart.ts", startLine: 2, endLine: 3, evidence: [{ filePath: "src/cart.ts", startLine: 2, quote: "return (cents * qty) / 100;" }], impact: "Customers are undercharged.", suggestedFix: "Keep integer cents.", symbol: "total", agent: "correctness", fingerprint: "fp1", commitSha: "a".repeat(40) } as unknown as Finding;

test("the portable fix prompt names the repository, revision, location and evidence without claiming execution", () => {
  const prompt = fixPrompt("acme/shop", "PR #7", [finding]);
  for (const part of ["acme/shop", "PR #7", "Totals become dollars [high, 93%]", "Commit: " + "a".repeat(40), "src/cart.ts:2-3", "return (cents * qty) / 100;", "No recorded OpenReview execution evidence for this revision."]) assert.ok(prompt.includes(part), part);
  assert.doesNotMatch(prompt, /tests (passed|ran)/i);
});

test("agent links use only the officially documented schemes, encode the prompt and add the repository", () => {
  const prompt = "Fix this & that\nline two #1";
  const github = agentLinks(prompt, agentRepoContext({ fullName: "acme/shop" }));
  assert.deepEqual(github.map((l) => l.url), [
    "cursor://anysphere.cursor-deeplink/prompt?text=Fix%20this%20%26%20that%0Aline%20two%20%231",
    "claude-cli://open?q=Fix%20this%20%26%20that%0Aline%20two%20%231&repo=acme/shop",
    "codex://new?prompt=Fix%20this%20%26%20that%0Aline%20two%20%231&originUrl=https%3A%2F%2Fgithub.com%2Facme%2Fshop",
    "conductor://prompt=Fix%20this%20%26%20that%0Aline%20two%20%231",
  ]);
  // Non-GitHub repositories: no Claude repo slug; Codex matches by the HTTPS remote when known.
  assert.deepEqual(agentRepoContext({ fullName: "Retail/shop", connectionId: "c1", remoteUrl: "https://dev.azure.com/fabrikam/Retail/_git/shop" }), { originUrl: "https://dev.azure.com/fabrikam/Retail/_git/shop" });
  assert.deepEqual(agentRepoContext({ fullName: "group/sub/repo", connectionId: "c2", remoteUrl: "git@gitlab.com:group/sub/repo.git" }), {});
  assert.equal(agentLinks("x", {})[1].url, "claude-cli://open?q=x");
});

test("prompts beyond each agent's link limit fall back to copy instead of truncating", () => {
  const long = agentLinks("y".repeat(5001), {});
  assert.ok(long[0].url, "Cursor allows up to 10,000 encoded characters");
  assert.equal(long[1].url, undefined);assert.match(long[1].unavailable!, /5,000-character/);
  const longer = agentLinks("z".repeat(codexPromptCap + 1), {});
  assert.equal(longer[2].url, undefined);
  assert.equal(agentLinks("é".repeat(2000), {})[0].url, undefined, "the Cursor limit applies to the encoded URL");
});
