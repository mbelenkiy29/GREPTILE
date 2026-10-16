import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAiAuthored, reviewModelFor } from "../src/ai-authored";
import { scopeDefaults, defaults } from "../src/review-settings";

const pr = (extra: Partial<Parameters<typeof detectAiAuthored>[0]> = {}) => ({ author: "alice", branch: "feature/totals", body: "Refactors totals.", commits: [{ message: "Fix totals" }], ...extra });

test("each explicit signal is detected, with the agent and the reason", () => {
  const cases: [Parameters<typeof detectAiAuthored>[0], string, string][] = [
    [pr({ author: "copilot-swe-agent[bot]" }), "GitHub Copilot", "author"],
    [pr({ author: "devin-ai-integration[bot]" }), "Devin", "author"],
    [pr({ author: "google-labs-jules[bot]" }), "Jules", "author"],
    [pr({ author: "chatgpt-codex-connector[bot]" }), "OpenAI Codex", "author"],
    [pr({ commits: [{ message: "Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" }] }), "Claude Code", "trailer"],
    [pr({ commits: [{ message: "Fix\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>" }] }), "Cursor", "trailer"],
    [pr({ commits: [{ message: "Fix\n\nCo-authored-by: aider (gpt-4.1) <noreply@aider.chat>" }] }), "Aider", "trailer"],
    [pr({ branch: "claude/fix-totals" }), "Claude Code", "branch"],
    [pr({ branch: "copilot/fix-123" }), "GitHub Copilot", "branch"],
    [pr({ branch: "cursor/refactor-totals-1a2b" }), "Cursor", "branch"],
    [pr({ branch: "codex/add-tests" }), "OpenAI Codex", "branch"],
    [pr({ body: "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" }), "Claude Code", "body"],
    [pr({ body: "Task: https://chatgpt.com/codex/tasks/task_e_123" }), "OpenAI Codex", "body"],
    [pr({ body: "Devin run: https://app.devin.ai/sessions/abc123" }), "Devin", "body"],
  ];
  for (const [input, agent, kind] of cases) assert.deepEqual([detectAiAuthored(input)?.agent, detectAiAuthored(input)?.kind], [agent, kind], JSON.stringify(input));
  // Author beats trailer beats branch beats body; the detail names the evidence.
  assert.deepEqual(detectAiAuthored(pr({ author: "devin-ai-integration[bot]", branch: "claude/x" })), { agent: "Devin", kind: "author", detail: "author devin-ai-integration[bot]" });
  assert.equal(detectAiAuthored(pr({ commits: [{ message: "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }] }))?.detail, "Co-Authored-By: Claude <noreply@anthropic.com>");
});

test("ordinary pull requests are not flagged: mentions, lookalike branches and human co-authors are not signals", () => {
  const ordinary = [
    pr(),
    pr({ branch: "feature/claude-integration" }),
    pr({ branch: "copilot-docs" }),
    pr({ body: "Adds the Copilot and Cursor integration guide; see https://claude.ai/docs for the API." }),
    pr({ body: "Generated with care by the payments team." }),
    pr({ commits: [{ message: "Pair\n\nCo-authored-by: Bob <bob@example.com>" }] }),
    pr({ commits: [{ message: "Mentions Claude in the message body but has no trailer" }] }),
    pr({ commits: [{ message: "Co-authored-by: Claude Shannon <claude@example.com>" }] }),
    pr({ author: "dependabot[bot]" }),
    pr({ author: "claudette" }),
    pr({ commits: [{}] }),
  ];
  for (const input of ordinary) assert.equal(detectAiAuthored(input), undefined, JSON.stringify(input));
});

test("routing uses aiAuthoredModel only for detected pull requests; the setting inherits like other review settings", () => {
  const signal = detectAiAuthored(pr({ branch: "claude/x" }));
  assert.deepEqual(reviewModelFor({ model: "gpt-4.1", aiAuthoredModel: "claude-sonnet-5-5" }, signal), { model: "claude-sonnet-5-5", routed: true });
  assert.deepEqual(reviewModelFor({ model: "gpt-4.1", aiAuthoredModel: "claude-sonnet-5-5" }, undefined), { model: "gpt-4.1", routed: false });
  assert.deepEqual(reviewModelFor({ model: "", aiAuthoredModel: "  " }, signal), { model: undefined, routed: false }, "off by default");
  assert.equal(defaults.aiAuthoredModel, "");
  // Workspace sets it, a team overrides it, other teams inherit the workspace value.
  const scopes = [{ settings: { aiAuthoredModel: "claude-sonnet-5-5" }, overrideKeys: ["aiAuthoredModel"] }, { teamId: "t1", settings: { aiAuthoredModel: "gpt-5" }, overrideKeys: ["aiAuthoredModel"] }, { teamId: "t2", settings: { aiAuthoredModel: "ignored" }, overrideKeys: [] }];
  assert.equal(scopeDefaults(scopes).aiAuthoredModel, "claude-sonnet-5-5");
  assert.equal(scopeDefaults(scopes, "t1").aiAuthoredModel, "gpt-5");
  assert.equal(scopeDefaults(scopes, "t2").aiAuthoredModel, "claude-sonnet-5-5");
  assert.equal(scopeDefaults([]).aiAuthoredModel, "");
});
