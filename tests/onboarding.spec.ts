import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { defaults } from "../src/review-settings";
import { needsSetup } from "../src/onboarding-steps";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "onboarding-session-secret-at-least-32-characters";
// Fake timers keep scheduled index jobs from running (they would call GitHub).
beforeEach(() => { vi.useFakeTimers(); process.env.SESSION_SECRET = secret; process.env.SERVICE_SECRET = "onboarding-service-secret"; delete process.env.BILLING_ENABLED; });
afterEach(() => { vi.useRealTimers(); });
const jwt = (id: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(id).setExpirationTime("1h").sign(new TextEncoder().encode(secret));

async function setup() {
  const t = convexTest(schema, modules);
  const login = (githubId: number, name: string) => t.mutation(api.users.login, { secret: "onboarding-service-secret", githubId, login: name, avatar: "" });
  const aliceId = await login(1, "alice"), bobId = await login(2, "bob");
  const alice = await jwt(aliceId), bob = await jwt(bobId);
  const organizationId = await t.mutation(api.users.createOrganization, { token: alice, name: "Setup" });
  await t.run(ctx => ctx.db.insert("organizationMembers", { organizationId, userId: bobId as Id<"users">, role: "member" }));
  await t.mutation(api.repositories.connect, { token: alice, secret: "onboarding-service-secret", organizationId, installationId: 301, account: "alice", accountId: 1, repositories: [{ id: 301, fullName: "alice/shop", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token: alice, organizationId });
  const workspaceRow = () => t.run(async ctx => (await ctx.db.query("scopeSettings").withIndex("by_org", q => q.eq("organizationId", organizationId)).collect()).find(s => !s.teamId));
  const audits = () => t.run(async ctx => (await ctx.db.query("auditEvents").withIndex("by_org", q => q.eq("organizationId", organizationId)).collect()).map(e => e.action));
  const organization = () => t.run(ctx => ctx.db.get(organizationId));
  return { t, alice, bob, organizationId, repo, workspaceRow, audits, organization };
}

test("new workspaces start guided setup; status exposes setup progress, resolved defaults and connected providers without credentials", async () => {
  const { t, alice, organizationId, organization } = await setup();
  const org = await organization();
  expect(org?.onboarding?.startedAt).toBeTypeOf("number");
  expect(needsSetup(org)).toBe(true);
  expect(needsSetup({})).toBe(false);
  const status = await t.query(api.onboarding.status, { token: alice, organizationId });
  expect(status.onboarding?.startedAt).toBe(org?.onboarding?.startedAt);
  expect(status.defaults.automatic).toBe(true);
  expect(status.defaults.summarySections).toEqual(defaults.summarySections);
  expect(status.connections).toEqual({ github: [{ account: "alice" }], providers: [] });
  expect(JSON.stringify(status.connections)).not.toMatch(/credential|secret|token/i);
});

test("indexing before configuration holds automatic reviews once, and never overwrites saved workspace settings", async () => {
  const { t, alice, organizationId, repo, workspaceRow, audits, organization } = await setup();
  await t.mutation(api.onboarding.select, { token: alice, organizationId, repositoryIds: [repo._id] });
  await expect(t.mutation(api.onboarding.start, { token: alice, organizationId })).rejects.toThrow("behavior");
  await t.mutation(api.onboarding.start, { token: alice, organizationId, pauseReviews: true });
  expect(await workspaceRow()).toMatchObject({ overrideKeys: ["automatic"], settings: { automatic: false } });
  expect((await organization())?.onboarding?.reviewsPaused).toBe(true);
  expect((await t.run(ctx => ctx.db.get(repo._id)))?.indexStatus).toBe("queued");
  expect((await t.query(api.onboarding.status, { token: alice, organizationId })).defaults.automatic).toBe(false);
  // A second start (retry) neither reseeds nor re-pauses.
  const seeded = (await workspaceRow())!;
  await t.run(ctx => ctx.db.patch(seeded._id, { settings: { ...seeded.settings, automatic: true, maxComments: 4 }, overrideKeys: ["automatic", "maxComments"] }));
  await t.mutation(api.onboarding.start, { token: alice, organizationId, pauseReviews: true });
  expect(await workspaceRow()).toMatchObject({ settings: { automatic: true, maxComments: 4 } });
  expect((await audits()).filter(a => a === "onboarding.reviews_paused")).toHaveLength(1);
});

test("configuration steps are admin-only, write only their own keys, validate values and audit", async () => {
  const { t, alice, bob, organizationId, repo, workspaceRow, audits, organization } = await setup();
  await t.mutation(api.onboarding.select, { token: alice, organizationId, repositoryIds: [repo._id] });
  await t.mutation(api.onboarding.start, { token: alice, organizationId, pauseReviews: true });
  const settings = { ...defaults, automatic: true, summarySections: ["overview", "score"], commentStyle: "detailed", maxComments: 3 };
  await expect(t.mutation(api.onboarding.saveDefaults, { token: bob, organizationId, step: "summary", settings })).rejects.toThrow("Forbidden");
  await expect(t.mutation(api.onboarding.saveDefaults, { token: alice, organizationId, step: "billing", settings })).rejects.toThrow("Unknown setup step");
  await t.mutation(api.onboarding.saveDefaults, { token: alice, organizationId, step: "summary", settings });
  let row = await workspaceRow();
  // automatic and maxComments belong to other steps: unchanged.
  expect(row?.settings).toMatchObject({ summarySections: ["overview", "score"], commentStyle: "detailed", automatic: false, maxComments: defaults.maxComments });
  expect(row?.overrideKeys.sort()).toEqual(["automatic", "commentStyle", "summarySections"]);
  await expect(t.mutation(api.onboarding.saveDefaults, { token: alice, organizationId, step: "comments", settings: { ...defaults, maxComments: 99 } })).rejects.toThrow("Invalid settings");
  await expect(t.mutation(api.onboarding.saveDefaults, { token: alice, organizationId, step: "summary", settings: { ...defaults, summarySections: ["overview", "nonsense"] } })).rejects.toThrow("Invalid settings");
  await t.mutation(api.onboarding.saveDefaults, { token: alice, organizationId, step: "comments", settings: { ...defaults, maxComments: 5, strictness: 1, categories: ["security", "correctness"] } });
  row = await workspaceRow();
  expect(row?.settings).toMatchObject({ maxComments: 5, strictness: 1, categories: ["security", "correctness"], summarySections: ["overview", "score"] });
  expect((await organization())?.onboarding).toMatchObject({ step: "comments", reviewsPaused: true });
  await t.mutation(api.onboarding.saveDefaults, { token: alice, organizationId, step: "triggers", settings: { ...defaults, automatic: false, drafts: true, triggerLabels: ["review-me"] } });
  expect((await workspaceRow())?.settings).toMatchObject({ automatic: false, drafts: true, triggerLabels: ["review-me"] });
  expect((await organization())?.onboarding).toMatchObject({ step: "triggers", reviewsPaused: false });
  const actions = await audits();
  expect(actions.filter(a => a === "settings.updated")).toHaveLength(3);
  expect(actions.filter(a => a === "onboarding.step_completed")).toHaveLength(3);
  // Completing after the triggers step keeps the explicit choice to keep reviews manual.
  await t.mutation(api.onboarding.complete, { token: alice, organizationId });
  expect((await workspaceRow())?.settings.automatic).toBe(false);
  expect((await organization())?.onboarding).toMatchObject({ step: "done", skipped: false });
});

test("leaving setup early releases the review hold; advance only records non-configuration steps", async () => {
  const { t, alice, bob, organizationId, repo, workspaceRow, audits, organization } = await setup();
  await t.mutation(api.onboarding.select, { token: alice, organizationId, repositoryIds: [repo._id] });
  await t.mutation(api.onboarding.start, { token: alice, organizationId, pauseReviews: true });
  await expect(t.mutation(api.onboarding.advance, { token: alice, organizationId, step: "summary" })).rejects.toThrow("Unknown setup step");
  await expect(t.mutation(api.onboarding.advance, { token: bob, organizationId, step: "indexing" })).rejects.toThrow("Forbidden");
  expect(await t.mutation(api.onboarding.advance, { token: alice, organizationId, step: "indexing" })).toBe("summary");
  expect((await organization())?.onboarding?.step).toBe("indexing");
  // The plan step only follows the team step where the deployment bills workspaces.
  expect(await t.mutation(api.onboarding.advance, { token: alice, organizationId, step: "team" })).toBe("done");
  process.env.BILLING_ENABLED = "true";
  try {
    expect(await t.mutation(api.onboarding.advance, { token: alice, organizationId, step: "team" })).toBe("plan");
    expect(await t.mutation(api.onboarding.advance, { token: alice, organizationId, step: "plan" })).toBe("done");
  } finally { delete process.env.BILLING_ENABLED; }
  expect((await organization())?.onboarding?.step).toBe("plan");
  await expect(t.mutation(api.onboarding.complete, { token: bob, organizationId, skipped: true })).rejects.toThrow("Forbidden");
  await t.mutation(api.onboarding.complete, { token: alice, organizationId, skipped: true });
  const org = await organization();
  expect(org?.onboarding).toMatchObject({ skipped: true, reviewsPaused: false });
  expect(org?.onboarding?.completedAt).toBeTypeOf("number");
  expect(needsSetup(org)).toBe(false);
  expect(await workspaceRow()).toMatchObject({ settings: { automatic: true }, overrideKeys: [] });
  expect(await audits()).toEqual(expect.arrayContaining(["onboarding.reviews_resumed", "onboarding.skipped"]));
  // Reopening and finishing again re-stamps completion.
  const first = org!.onboarding!.completedAt!;
  vi.setSystemTime(first + 60_000);
  await t.mutation(api.onboarding.complete, { token: alice, organizationId });
  expect((await organization())?.onboarding?.completedAt).toBeGreaterThan(first);
});

test("the code-graph sample is bounded to 12 files per repository and limited to repositories the viewer can see", async () => {
  const { t, alice, bob, organizationId, repo } = await setup();
  const hidden = await t.run(async ctx => {
    const teamId = await ctx.db.insert("teams", { organizationId, name: "Private", createdAt: Date.now() });
    const { _id, _creationTime, ...fields } = repo; void _id; void _creationTime;
    return ctx.db.insert("repositories", { ...fields, githubId: 302, fullName: "alice/private", teamId, enabled: true });
  });
  await t.run(async ctx => {
    const storageId = await ctx.storage.store(new Blob(["export {}"]));
    for (const repositoryId of [repo._id, hidden]) for (let i = 0; i < 20; i++)
      await ctx.db.insert("repositoryFiles", { organizationId, repositoryId, path: `src/file${i}.ts`, sha: String(i), storageId, language: "typescript", updatedAt: Date.now() });
    await ctx.db.insert("graphModuleReferences", { repositoryId: repo._id, path: "src/file0.ts", sha: "0", graphVersion: 4, references: [{ specifier: "./file1", resolvedPath: "src/file1.ts" }, { specifier: "./gone", resolvedPath: "src/file19.ts" }, { specifier: "./self", resolvedPath: "src/file0.ts" }] });
  });
  await t.mutation(api.onboarding.select, { token: alice, organizationId, repositoryIds: [repo._id, hidden] });
  const admin = await t.query(api.onboarding.status, { token: alice, organizationId });
  expect(admin.graph.map(g => [g.repository, g.files.length])).toEqual([["alice/shop", 12], ["alice/private", 12]]);
  // Only references between sampled files, never self-edges.
  expect(admin.graph[0].edges).toEqual([["src/file0.ts", "src/file1.ts"]]);
  const member = await t.query(api.onboarding.status, { token: bob, organizationId });
  expect(member.graph.map(g => g.repository)).toEqual(["alice/shop"]);
});
