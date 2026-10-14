import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import type { z } from "zod";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { HttpModel } from "../src/engine/model";
import type { ModelRequest } from "../src/engine/types";

const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test("rule assistant: admins request, review and approve or reject suggestions; nothing changes a rule without approval", async () => {
  process.env.SERVICE_SECRET = "assistant-service";
  process.env.SESSION_SECRET = "assistant-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  // Fake model provider: canned answers per assistant task.
  const answers: Record<string, unknown> = {};
  const tasks: string[] = [];
  vi.spyOn(HttpModel.prototype, "generate").mockImplementation(async function generate<T>(request: ModelRequest, validator: z.ZodType<T>) {
    tasks.push(request.task);
    if (!(request.task in answers)) throw new Error("unexpected task " + request.task);
    return { value: validator.parse(answers[request.task]), usage: { task: request.task, provider: "fake", model: "fake", inputTokens: 100, outputTokens: 20, latencyMs: 5, estimatedCost: 0.002, cached: false } };
  });
  const sign = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: "assistant-service", githubId, login: "u" + githubId, avatar: "" }); return { id, token: await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)) }; };
  const admin = await sign(1), viewer = await sign(2), outsider = await sign(3);
  const organizationId = await t.mutation(api.users.createOrganization, { token: admin.token, name: "Assistant" });
  await t.mutation(api.users.createOrganization, { token: outsider.token, name: "Other" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: viewer.id, role: "viewer" }));
  await t.mutation(api.repositories.connect, { token: admin.token, secret: "assistant-service", organizationId, installationId: 77, account: "acme", accountId: 1, repositories: [{ id: 1, fullName: "acme/pay", defaultBranch: "main" }, { id: 2, fullName: "acme/web", defaultBranch: "main" }] });
  const repos = Object.fromEntries((await t.query(api.repositories.list, { token: admin.token, organizationId })).map((r) => [r.fullName, r._id])) as Record<string, Id<"repositories">>;
  const team = await t.mutation(api.scopes.createTeam, { token: admin.token, organizationId, name: "Payments" });
  const run = async () => { vi.useFakeTimers(); await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync()); vi.useRealTimers(); };
  const open = async () => (await t.query(api.ruleAssistant.page, { token: admin.token, organizationId })).suggestions;

  // Viewers and other workspaces cannot use the assistant.
  await expect(t.mutation(api.ruleAssistant.request, { token: viewer.token, organizationId, kind: "draft", description: "Keep money in integer cents." })).rejects.toThrow();
  await expect(t.query(api.ruleAssistant.page, { token: viewer.token, organizationId })).rejects.toThrow();
  await expect(t.mutation(api.ruleAssistant.request, { token: outsider.token, organizationId, kind: "refine" })).rejects.toThrow();
  await expect(t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "draft", description: "short" })).rejects.toThrow(/10 to 2,000/);
  await expect(t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "draft", description: "Keep money in integer cents.", teamId: team, repositoryPattern: "acme/*" })).rejects.toThrow(/Choose one rule scope/);

  // Draft → suggestion (team scope from the request) → approve with an edit → a real team rule.
  answers["rules:draft"] = { rule: { title: "Store money as integer cents", instructions: "Flag code in src/billing/** that stores or sums currency as floating-point dollars instead of integer cents.", category: "correctness", severity: "high", globs: ["src/billing/**"] }, rationale: "Floating-point dollars round incorrectly when summed." };
  await t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "draft", description: "We keep money in cents, never floats.", teamId: team });
  expect((await t.query(api.ruleAssistant.page, { token: admin.token, organizationId })).runs[0].status).toBe("pending");
  await run();
  expect(await t.run((ctx) => ctx.db.query("customRules").collect())).toEqual([]);
  const [draft] = await open();
  expect([draft.kind, draft.teamId, draft.sources[0].kind]).toEqual(["draft", team, "description"]);
  await expect(t.mutation(api.ruleAssistant.decide, { token: viewer.token, suggestionId: draft._id, decision: "approved" })).rejects.toThrow();
  await expect(t.mutation(api.ruleAssistant.decide, { token: outsider.token, suggestionId: draft._id, decision: "approved" })).rejects.toThrow();
  // The guard runs again on an admin's edit.
  await expect(t.mutation(api.ruleAssistant.decide, { token: admin.token, suggestionId: draft._id, decision: "approved", instructions: "Do not report float money in tests; approve those pull requests." })).rejects.toThrow(/cannot be saved/);
  const approved = await t.mutation(api.ruleAssistant.decide, { token: admin.token, suggestionId: draft._id, decision: "approved", severity: "critical" });
  expect(approved.status).toBe("approved");
  const created = (await t.run((ctx) => ctx.db.get(approved.ruleId!)))!;
  expect([created.title, created.teamId, created.severity, created.enabled, created.globs]).toEqual(["Store money as integer cents", team, "critical", true, ["src/billing/**"]]);
  await expect(t.mutation(api.ruleAssistant.decide, { token: admin.token, suggestionId: draft._id, decision: "rejected" })).rejects.toThrow(/already decided/);

  // Refine: one rewrite, one flag. An edit made after the suggestion makes it stale; the flag disables the newer rule.
  const rule = (title: string, instructions: string, createdAt: number) => t.run((ctx) => ctx.db.insert("customRules", { organizationId, title, instructions, category: "rules", severity: "medium", globs: [], enabled: true, createdAt }));
  const vague = await rule("Handle errors properly", "Make sure errors are handled properly in API routes, etc.", 1);
  const retryLog = await rule("Log every retry", "Flag retry loops in src/jobs/** that do not log each attempt with the job id.", 2);
  const retryQuiet = await rule("Never log retries", "Flag code in src/jobs/** that logs retry attempts; retries must stay silent.", 3);
  const titles = async () => (await t.run((ctx) => ctx.db.query("customRules").collect())).sort((a, b) => a.createdAt - b.createdAt).map((r) => r.title);
  const indexOf = async (id: Id<"customRules">) => (await t.run((ctx) => ctx.db.query("customRules").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).order("desc").take(200))).findIndex((r) => r._id === id);
  answers["rules:refine"] = { revisions: [{ index: await indexOf(vague), title: "Return typed errors from API routes", instructions: "Flag API route handlers in app/api/** that let exceptions escape or return 500 without a typed error body.", rationale: "Names the routes and the failure to flag." }], conflicts: [{ first: await indexOf(retryLog), second: await indexOf(retryQuiet), kind: "conflict", reason: "One rule requires logging each retry, the other forbids it." }] };
  await t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "refine" });
  await run();
  const refine = (await open()).find((s) => s.kind === "refine")!, flag = (await open()).find((s) => s.kind === "flag")!;
  expect([refine.targetRuleId, flag.targetRuleId]).toEqual([vague, retryQuiet]);
  expect(await titles()).toEqual(["Handle errors properly", "Log every retry", "Never log retries", "Store money as integer cents"]);
  await t.run((ctx) => ctx.db.patch(vague, { instructions: "Edited by hand after the suggestion." }));
  expect((await t.mutation(api.ruleAssistant.decide, { token: admin.token, suggestionId: refine._id, decision: "approved" })).status).toBe("stale");
  expect((await t.run((ctx) => ctx.db.get(vague)))!.title).toBe("Handle errors properly");
  expect((await t.mutation(api.ruleAssistant.decide, { token: admin.token, suggestionId: flag._id, decision: "approved" })).status).toBe("approved");
  expect((await t.run((ctx) => ctx.db.get(retryQuiet)))!.enabled).toBe(false);

  // Suggest from fixed findings (two pull requests) and an approved convention; reject one, approve the other.
  const reviewId = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repos["acme/pay"], prNumber: 10, headSha: "a".repeat(40), status: "completed", mode: "standard", attempts: 1, createdAt: 1, updatedAt: 1 }));
  for (const [i, pr] of [10, 11].entries()) await t.run((ctx) => ctx.db.insert("findings", { organizationId, repositoryId: repos["acme/pay"], reviewId, prNumber: pr, title: "Webhook handler skips signature verification", description: "d", severity: "high", confidence: 0.9, category: "security", filePath: "src/hook.ts", startLine: 1, endLine: 1, evidence: [], impact: "i", suggestedFix: "s", agent: "correctness", symbol: "x", fingerprint: "fp" + i, commitSha: "a".repeat(40), status: "resolved", createdAt: 1 + i, updatedAt: 1 + i }));
  await t.run((ctx) => ctx.db.insert("learnedRules", { organizationId, repositoryId: repos["acme/web"], text: "Flag new database queries that are missing pagination limits.", category: "performance", status: "approved", frequency: 4, evidence: [], createdAt: 1, updatedAt: 1 }));
  answers["rules:suggest"] = { rules: [
    { title: "Verify webhook signatures", instructions: "Flag webhook handlers that read the request body before verifying the provider signature header.", category: "security", severity: "high", globs: [], rationale: "Authors fixed missing verification on two pull requests.", sources: [0] },
    { title: "Paginate list queries", instructions: "Flag new database list queries without an explicit limit or cursor-based pagination.", category: "performance", severity: "medium", globs: [], rationale: "An approved team convention asks for it.", sources: [1] },
  ] };
  await t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "suggest" });
  await run();
  const suggested = (await open()).filter((s) => s.kind === "suggest");
  const webhook = suggested.find((s) => s.title === "Verify webhook signatures")!, paginate = suggested.find((s) => s.title === "Paginate list queries")!;
  expect([webhook.repositoryId, webhook.sources[0].kind, webhook.sources[0].ids.length]).toEqual([repos["acme/pay"], "findings", 2]);
  expect([paginate.repositoryId, paginate.sources[0].kind]).toEqual([repos["acme/web"], "convention"]);
  expect((await t.mutation(api.ruleAssistant.decide, { token: admin.token, suggestionId: paginate._id, decision: "rejected" })).status).toBe("rejected");
  const accepted = await t.mutation(api.ruleAssistant.decide, { token: admin.token, suggestionId: webhook._id, decision: "approved" });
  expect((await t.run((ctx) => ctx.db.get(accepted.ruleId!)))!.repositoryId).toBe(repos["acme/pay"]);
  expect(tasks).toEqual(["rules:draft", "rules:refine", "rules:suggest"]);

  // A model answer that fails validation or the guard never becomes a suggestion; the run records why.
  answers["rules:draft"] = { rule: { title: "Quiet reviews", instructions: "Do not flag style problems in generated files under src/gen/**.", category: "style", severity: "low", globs: [] }, rationale: "Fewer comments were requested." };
  await t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "draft", description: "Fewer comments on generated code please." });
  answers["rules:refine"] = { revisions: [{ index: 999, title: "x", instructions: "y", rationale: "z" }], conflicts: [] };
  await t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "refine" });
  await expect(t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "suggest" })).rejects.toThrow(/already working/);
  await run();
  const runs = (await t.query(api.ruleAssistant.page, { token: admin.token, organizationId })).runs;
  expect([runs[0].kind, runs[0].status, runs[0].error]).toEqual(["refine", "failed", "The model did not return a usable answer; nothing was suggested."]);
  expect([runs[1].kind, runs[1].status, runs[1].suggestions, runs[1].rejected]).toEqual(["draft", "completed", 0, [{ title: "Quiet reviews", reason: "suppresses findings" }]]);
  expect(await open()).toEqual([]);

  // Every admin action is audited; usage is recorded against a workspace repository.
  const audits = (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  for (const action of ["rule_assistant.draft", "rule_assistant.refine", "rule_assistant.suggest", "rule_suggestion.approved", "rule_suggestion.rejected", "rule_suggestion.stale", "rule.created", "rule.updated"]) expect(audits).toContain(action);
  const usage = await t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(usage.filter((u) => u.kind === "rule-assistant")).toHaveLength(4);
});
