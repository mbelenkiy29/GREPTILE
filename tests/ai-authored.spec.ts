import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import type { z } from "zod";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";
import { HttpModel } from "../src/engine/model";
import { defaults } from "../src/review-settings";
import type { ModelRequest } from "../src/engine/types";

const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test("agent-authored pull requests are reviewed with the configured model and the reason is recorded; others are not", async () => {
  process.env.SERVICE_SECRET = "ai-service";
  process.env.SESSION_SECRET = "ai-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const heads: Record<number, { sha: string; ref: string; body: string; commits: { sha: string; message?: string }[] }> = {
    1: { sha: "b".repeat(40), ref: "feature/totals", body: "Refactors totals.", commits: [{ sha: "1".repeat(40), message: "Fix totals\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" }] },
    2: { sha: "c".repeat(40), ref: "feature/totals-2", body: "Refactors totals by hand.", commits: [{ sha: "2".repeat(40), message: "Fix totals\n\nCo-authored-by: Alice <alice@example.com>" }] },
  };
  vi.spyOn(Github, "installation").mockResolvedValue(new Github("test-only-token"));
  vi.spyOn(Github.prototype, "request").mockImplementation(async (path, validator) => validator.parse(path.endsWith("/permission") ? { permission: "write" } : /\/pulls\/\d+$/.test(path) ? (() => { const n = Number(path.split("/").at(-1)); return { number: n, title: "Totals", draft: false, state: "open", html_url: `https://github.com/test/ai/pull/${n}`, user: { login: "author" }, head: { sha: heads[n].sha, ref: heads[n].ref }, base: { sha: "a".repeat(40), ref: "main" } }; })() : { sha: "a".repeat(40) }));
  vi.spyOn(Github.prototype, "openChanges").mockResolvedValue({ numbers: [], next: null });
  vi.spyOn(Github.prototype, "branches").mockResolvedValue({ branches: [{ name: "main", sha: "a".repeat(40), protected: true }], limited: false });
  vi.spyOn(Github.prototype, "tree").mockResolvedValue([{ path: "total.ts", sha: "t", type: "blob", size: 60 }]);
  vi.spyOn(Github.prototype, "blob").mockImplementation(async (_repo, path, sha) => ({ path, sha, content: "export function total(cents) {\n  return cents / 100;\n}" }));
  vi.spyOn(Github.prototype, "pullRequest").mockImplementation(async (_repo, n) => ({ number: n, title: "Totals", body: heads[n].body, draft: false, state: "open", html_url: `https://github.com/test/ai/pull/${n}`, user: { login: "author" }, head: { sha: heads[n].sha, ref: heads[n].ref }, base: { sha: "a".repeat(40), ref: "main" }, diff: [{ path: "total.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(cents) {\n-  return cents;\n+  return cents / 100;\n }" }], comments: [], reviews: [], commits: heads[n].commits, checks: [] }) as never);
  vi.spyOn(Github.prototype, "publish").mockResolvedValue({ id: 700, reused: false, comments: [] });
  vi.spyOn(Github.prototype, "startCheckRun").mockResolvedValue(null);
  // Fake model provider: records which configured model served each review call.
  const served: { task: string; model: string; head?: string }[] = [];
  vi.spyOn(HttpModel.prototype, "generate").mockImplementation(async function generate<T>(this: HttpModel, request: ModelRequest, validator: z.ZodType<T>) {
    served.push({ task: request.task, model: (this as unknown as { config: { model: string } }).config.model, head: (request.context as { headSha?: string } | undefined)?.headSha });
    const value = request.task.startsWith("review:") ? { findings: [] } : request.task === "knowledge" ? { entries: [] } : request.task === "diagram" ? { diagram: null } : { reviewScore: { value: 4, reason: "No verified defects; currency handling is unchanged elsewhere." }, summary: "Totals are now computed in dollars." };
    return { value: validator.parse(value), usage: { task: request.task, provider: "fake", model: (this as unknown as { config: { model: string } }).config.model, inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  });
  const userId = await t.mutation(api.users.login, { secret: "ai-service", githubId: -300, login: "ai-fixture", avatar: "" });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "AI routing" });
  await t.mutation(api.repositories.connect, { token, secret: "ai-service", organizationId, installationId: -300, accountId: -300, account: "test", repositories: [{ id: -300, fullName: "test/ai", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  vi.useFakeTimers();
  await t.mutation(api.repositories.configure, { token, repositoryId: repo._id, enabled: true, settings: { ...defaults, aiAuthoredModel: "claude-sonnet-5-5", summarySections: ["overview", "findings"] } });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  for (const n of [1, 2]) {
    const payloadStorageId = await t.run((ctx) => ctx.storage.store(new Blob([JSON.stringify({ action: "opened", installation: { id: -300 }, repository: { id: -300 }, pull_request: { number: n, draft: false, state: "open", head: { sha: heads[n].sha, ref: heads[n].ref }, base: { ref: "main" }, user: { login: "author" } } })])));
    await t.mutation(internal.webhooks.receive, { deliveryId: "ai-" + n, event: "pull_request", payloadStorageId });
    await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  }
  const reviewCalls = (head: string) => served.filter((s) => s.task.startsWith("review:") && s.head === head);
  expect(reviewCalls(heads[1].sha).length).toBeGreaterThan(0);
  expect(new Set(reviewCalls(heads[1].sha).map((s) => s.model))).toEqual(new Set(["claude-sonnet-5-5"]));
  expect(reviewCalls(heads[2].sha).length).toBeGreaterThan(0);
  expect(reviewCalls(heads[2].sha).every((s) => s.model !== "claude-sonnet-5-5")).toBe(true);
  const reviews = await t.run((ctx) => ctx.db.query("reviews").collect());
  const agent = reviews.find((r) => r.prNumber === 1)!, human = reviews.find((r) => r.prNumber === 2)!;
  expect([agent.status, human.status]).toEqual(["completed", "completed"]);
  expect(agent.aiAuthored).toEqual({ agent: "Claude Code", kind: "trailer", detail: "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", model: "claude-sonnet-5-5" });
  expect(human.aiAuthored).toBeUndefined();
  // K2: the job records the tier it used and why (here: the configured tier, no request, no cap).
  expect(agent.modeDecision).toEqual({ mode: "standard", source: "settings", capped: false, requested: "standard" });
  expect((await t.query(api.reviews.detail, { token, reviewId: agent._id })).review.aiAuthored?.agent).toBe("Claude Code");
});
