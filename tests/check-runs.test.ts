import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Github, checkConclusion } from "../src/github";

test("check run conclusions: neutral by default, failure at or above the configured severity, success otherwise", () => {
  const findings = [{ severity: "medium" as const }, { severity: "low" as const }];
  assert.equal(checkConclusion(findings, undefined), "neutral");
  assert.equal(checkConclusion(findings, "off"), "neutral");
  assert.equal(checkConclusion(findings, "high"), "success");
  assert.equal(checkConclusion(findings, "medium"), "failure");
  assert.equal(checkConclusion(findings, "low"), "failure");
  assert.equal(checkConclusion([{ severity: "critical" }], "critical"), "failure");
  assert.equal(checkConclusion([], "low"), "success");
  assert.equal(checkConclusion(findings, "bogus"), "neutral");
});

test("check runs are created in progress and completed only with checks:write; without it nothing is sent", async (t) => {
  t.mock.method(console, "log", () => {});
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    requests.push({ method: options.method ?? "GET", path: new URL(url).pathname, body: options.body ? JSON.parse(String(options.body)) : {} });
    return Response.json({ id: 77 });
  });
  const writer = new Github("fixture", undefined, undefined, { checks: "write", contents: "read", pull_requests: "write", issues: "read" });
  assert.equal(await writer.startCheckRun("o/r", "a".repeat(40), "review-1", "https://app.example.com/dashboard/pulls/review-1"), 77);
  await writer.completeCheckRun("o/r", 77, { conclusion: "failure", title: "2 verified findings", summary: "- **high** Totals become dollars", detailsUrl: "https://app.example.com/dashboard/pulls/review-1" });
  assert.deepEqual(requests.map((r) => [r.method, r.path]), [["POST", "/repos/o/r/check-runs"], ["PATCH", "/repos/o/r/check-runs/77"]]);
  assert.deepEqual([requests[0].body.name, requests[0].body.status, requests[0].body.head_sha, requests[0].body.external_id], ["OpenReview", "in_progress", "a".repeat(40), "review-1"]);
  assert.deepEqual([requests[1].body.status, requests[1].body.conclusion, (requests[1].body.output as { title: string }).title], ["completed", "failure", "2 verified findings"]);
  requests.length = 0;
  const reader = new Github("fixture", undefined, undefined, { checks: "read", contents: "read", pull_requests: "write", issues: "read" });
  assert.equal(await reader.startCheckRun("o/r", "a".repeat(40), "review-1"), null);
  await reader.completeCheckRun("o/r", 77, { conclusion: "neutral", title: "x", summary: "y" });
  assert.equal(requests.length, 0);
});

test("installations keep their required-permission validation and expose granted permissions", async (t) => {
  t.mock.method(console, "log", () => {});
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  let permissions: Record<string, string> = { contents: "read", pull_requests: "write", issues: "read", checks: "read" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ token: "installation-token", permissions }));
  const config = { appId: "1", privateKey, base: "https://api.github.com" };
  assert.equal((await Github.installation(5, config)).permissions?.checks, "read", "checks:read installs still work");
  permissions = { ...permissions, checks: "write" };
  assert.equal((await Github.installation(5, config)).permissions?.checks, "write");
  permissions = { contents: "read", pull_requests: "write", issues: "read" };
  await assert.rejects(Github.installation(5, config), /checks:read/, "existing validation is unchanged");
});
