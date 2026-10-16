import { test } from "node:test";
import assert from "node:assert/strict";
import { forbiddenPush, pushArgs, runResolveLoop, type LoopFinding, type LoopOptions } from "../src/resolve-loop";
import { fixCommand, fixInstructions, localGit } from "../src/resolve-cli";

const finding = (id: string, prNumber = 7): LoopFinding => ({ findingId: id, title: `Finding ${id}`, severity: "high", filePath: "src/a.ts", line: 3, suggestedFix: "Keep cents.", prNumber });
// Fake MCP server: scripted unresolved findings per round; the review of a pushed commit completes after
// one extra poll. Records every call.
function fakeMcp(rounds: LoopFinding[][], reviewStatus: "completed" | "failed" | "never" = "completed") {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let round = 0, triggered: string | undefined, polls = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "list_unresolved_comments") return { findings: rounds[Math.min(round++, rounds.length - 1)] };
    if (name === "trigger_review") { triggered = args.headSha as string; polls = 0; return { reviewId: "r" }; }
    if (name === "get_review_status") {
      polls++;
      if (reviewStatus === "never" || polls < 2) return { review: { headSha: "old", status: "completed" } };
      return { review: { headSha: triggered, status: reviewStatus } };
    }
    throw new Error("unexpected tool " + name);
  };
  return { call, calls };
}
function fakeGit(changes = true) {
  const commits: string[] = [], pushes: string[][] = [];
  return { commits, pushes, git: { commit: async (message: string) => { if (!changes) return null; const sha = String(commits.length + 1).repeat(40); commits.push(message); return sha; }, push: async () => { pushes.push([...pushArgs()]); } } };
}
const options = (extra: Partial<LoopOptions> = {}): LoopOptions => ({ repositoryId: "repo", prNumber: 7, maxIterations: 3, push: "always", fix: async () => {}, wait: async () => {}, pollMs: 1, ...extra });

test("stops as soon as the pull request is clean, re-reviewing exactly the pushed commit", async () => {
  const mcp = fakeMcp([[finding("a"), finding("b"), finding("other", 8)], []]);
  const g = fakeGit();
  const fixed: string[][] = [];
  const result = await runResolveLoop(mcp.call, g.git, options({ fix: async (f) => { fixed.push(f.map((x) => x.findingId)); } }));
  assert.deepEqual(result, { outcome: "clean", iterations: 1, remaining: 0, commits: ["1".repeat(40)] });
  assert.deepEqual(fixed, [["a", "b"]], "findings of other pull requests are left alone");
  assert.deepEqual(g.commits, ["Address OpenReview findings (round 1)"]);
  assert.deepEqual(mcp.calls.find((c) => c.name === "trigger_review")!.args, { repositoryId: "repo", prNumber: 7, headSha: "1".repeat(40) });
  assert.equal(mcp.calls.filter((c) => c.name === "get_review_status").length, 2, "polled until the new commit's review completed");
  // Already clean: no fix, commit or push at all.
  const idle = fakeGit();
  assert.deepEqual(await runResolveLoop(fakeMcp([[]]).call, idle.git, options()), { outcome: "clean", iterations: 0, remaining: 0, commits: [] });
  assert.deepEqual([idle.commits, idle.pushes], [[], []]);
});

test("stops at the iteration limit when findings keep coming back", async () => {
  const g = fakeGit();
  const result = await runResolveLoop(fakeMcp([[finding("a")]]).call, g.git, options({ maxIterations: 2 }));
  assert.deepEqual([result.outcome, result.iterations, result.remaining, result.commits.length, g.pushes.length], ["max-iterations", 2, 1, 2, 2]);
});

test("never force-pushes, and only pushes when allowed", async () => {
  assert.deepEqual(pushArgs(), ["push"]);
  assert.equal(forbiddenPush(pushArgs()), false);
  for (const bad of [["push", "--force"], ["push", "--force-with-lease"], ["push", "-f"], ["push", "-uf"], ["push", "origin", "+main"], ["push", "--force-if-includes"]]) assert.equal(forbiddenPush(bad), true, bad.join(" "));
  // The real git adapter: the push argv is exactly `git push`.
  const argv: string[][] = [];
  const git = localGit("/repo", async (file, args) => { argv.push([file, ...args]); return { stdout: args[0] === "status" ? " M src/a.ts" : args[0] === "rev-parse" ? "f".repeat(40) : "" }; });
  assert.equal(await git.commit("msg"), "f".repeat(40));
  await git.push();
  assert.deepEqual(argv, [["git", "add", "-A"], ["git", "status", "--porcelain"], ["git", "commit", "-m", "msg"], ["git", "rev-parse", "HEAD"], ["git", "push"]]);
  assert.equal(argv.some((a) => forbiddenPush(a.slice(1))), false);
  // push: never → stops after the local commit; ask → declined means no push and no re-review.
  const never = fakeGit(), neverMcp = fakeMcp([[finding("a")]]);
  assert.equal((await runResolveLoop(neverMcp.call, never.git, options({ push: "never" }))).outcome, "push-required");
  assert.deepEqual([never.pushes.length, neverMcp.calls.some((c) => c.name === "trigger_review")], [0, false]);
  const asked: string[] = [], declined = fakeGit();
  assert.equal((await runResolveLoop(fakeMcp([[finding("a")]]).call, declined.git, options({ push: "ask", ask: async (q) => { asked.push(q); return false; } }))).outcome, "push-declined");
  assert.deepEqual([declined.pushes.length, asked], [0, ["Push commit 1111111 so OpenReview can review it?"]]);
});

test("stops when the agent changes nothing, when the re-review fails, or when it times out", async () => {
  assert.equal((await runResolveLoop(fakeMcp([[finding("a")]]).call, fakeGit(false).git, options())).outcome, "no-changes");
  assert.equal((await runResolveLoop(fakeMcp([[finding("a")]], "failed").call, fakeGit().git, options())).outcome, "review-failed");
  assert.equal((await runResolveLoop(fakeMcp([[finding("a")]], "never").call, fakeGit().git, options({ reviewTimeoutMs: 0 }))).outcome, "review-timeout");
});

test("agents run in their documented non-interactive modes with edits allowed and nothing broader", () => {
  const prompt = fixInstructions("acme/shop", 7, [finding("a")]);
  assert.match(prompt, /Do not commit, push or change git configuration/);
  assert.match(prompt, /1\. \[high\] Finding a\n {3}src\/a\.ts:3\n {3}Suggested fix: Keep cents\./);
  assert.deepEqual(fixCommand("claude", "p"), { file: "claude", args: ["-p", "p", "--permission-mode", "acceptEdits"] });
  assert.deepEqual(fixCommand("codex", "p"), { file: "codex", args: ["exec", "--sandbox", "workspace-write", "p"] });
  for (const agent of ["claude", "codex"] as const) assert.doesNotMatch(fixCommand(agent, "p").args.join(" "), /dangerously|danger-full-access|bypassPermissions|--yolo/);
});
