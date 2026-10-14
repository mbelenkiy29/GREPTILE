import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { findingSchema, type Candidate, type Finding, type ModelProvider, type ModelRequest } from "../src/engine/types";
import { findingComment } from "../src/review-summary";
import { reviewChange } from "../src/engine/review";
import { reviewVerdict } from "../src/verdict";
import { wantsAnswer } from "../src/thread-replies";
import type { ReviewInput } from "../src/engine/types";

const candidate: Candidate = {
  title: "Deleted accounts remain authorized", description: "The caller treats undefined as an active account, allowing deleted users to access the organization.",
  severity: "high", confidence: 0.97, category: "security", filePath: "auth.ts", startLine: 2, endLine: 2,
  evidence: [{ filePath: "auth.ts", startLine: 2, quote: "  return user?.active !== false;" }],
  impact: "Deleted users retain organization access.", suggestedFix: "Require a present user and active === true.", symbol: "allowed",
};
const input: ReviewInput = {
  repository: "fixture/questions", baseSha: "base", headSha: "head", title: "Handle missing accounts", description: "",
  files: [{ path: "auth.ts", sha: "1", content: "export function allowed(user) {\n  return user?.active !== false;\n}" }],
  diff: [{ path: "auth.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function allowed(user) {\n-  return user.active;\n+  return user?.active !== false;\n }" }],
  rules: [], mode: "standard",
};

const base: Finding = { ...candidate, fingerprint: "f".repeat(16), agent: "security", commitSha: "head" };

test("a finding may carry one short question for the author, rendered under the comment with mentions neutralised", () => {
  assert.ok(findingSchema.safeParse({ ...candidate, question: "Is a missing user meant to be treated as active here?" }).success);
  assert.equal(findingSchema.safeParse({ ...candidate, question: "x".repeat(301) }).success, false);
  assert.equal(findingSchema.safeParse({ ...candidate, question: "why" }).success, false);
  const comment = findingComment({ ...base, question: "Should @alice confirm whether\nguests count as active?" });
  assert.match(comment, /\*\*Fix:\*\* Require a present user and active === true\.\n\n\*\*Question for the author:\*\* Should @​alice confirm whether guests count as active\?\n\nEvidence:/);
  assert.doesNotMatch(findingComment(base), /Question for the author/);
});

test("a question never counts as a finding or changes the verdict on its own", async () => {
  assert.equal(reviewVerdict({ score: 5, findings: [] }), "ready");
  const asked: Finding = { ...base, severity: "low", question: "Is this intended?" }, plain: Finding = { ...base, severity: "low" };
  assert.equal(reviewVerdict({ score: 4, findings: [asked] }), reviewVerdict({ score: 4, findings: [plain] }));
  // A question that claims test results is rejected like any other finding text.
  const requests: ModelRequest[] = [];
  const model: ModelProvider = {
    async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
      requests.push(request);
      const findings: Candidate[] = request.task === "review:security" ? [{ ...candidate, question: "The tests passed, so is this intended?" }] : [];
      const value = request.task.startsWith("review:") ? { findings } : request.task === "verify" ? { decisions: [] } : request.task === "diagram" ? { diagram: null } : { reviewScore: { value: 5, reason: "No verified defects remain in the reviewed change." }, summary: "This change updates the authentication guard." };
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw Object.assign(new Error("invalid"), { usage: { task: request.task, provider: "f", model: "f", inputTokens: 0, outputTokens: 0, latencyMs: 0, estimatedCost: 0, cached: false } });
      return { value: parsed.data, usage: { task: request.task, provider: "f", model: "f", inputTokens: 0, outputTokens: 0, latencyMs: 0, estimatedCost: 0, cached: false } };
    },
  };
  const result = await reviewChange({ ...input, settings: { categories: ["security", "correctness"] } }, model);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.metadata.failedSpecialists?.map((f) => f.category), ["security"]);
  assert.match(requests.find((r) => r.task === "review:security")!.system, /optional question \(at most 300 characters\) asking the author about intent/);
});

test("unmentioned replies skip bare acknowledgements and quoted-only text", () => {
  for (const text of ["Why is this a problem when the caller checks first?", "This is intentional: guests are active by design.", "fixed in the next commit, but why does the retry matter?"]) assert.equal(wantsAnswer(text), true, text);
  for (const text of ["Thanks!", "thank you 🙏", "LGTM", "fixed.", "done, thanks", "👍", "> quoted\nok", "", " k "]) assert.equal(wantsAnswer(text), false, text);
});
