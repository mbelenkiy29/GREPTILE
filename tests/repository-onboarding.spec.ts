import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { autoEnableNewRepository } from "../convex/repositoryOnboarding";

const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { vi.useRealTimers(); });

async function workspace(prefix: string) {
  process.env.SERVICE_SECRET = prefix + "-service";
  process.env.SESSION_SECRET = prefix + "-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const sign = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: prefix + "-service", githubId, login: prefix + githubId, avatar: "" }); return { id, token: await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)) }; };
  const admin = await sign(1), viewer = await sign(2);
  const organizationId = await t.mutation(api.users.createOrganization, { token: admin.token, name: prefix });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: viewer.id, role: "viewer" }));
  return { t, admin, viewer, organizationId };
}

test("auto-enable: new repositories from the installation webhook stay disabled unless the workspace or team turns it on", async () => {
  const { t, admin, viewer, organizationId } = await workspace("auto");
  await t.mutation(api.repositories.connect, { token: admin.token, secret: "auto-service", organizationId, installationId: 91, account: "acme", accountId: 1, repositories: [{ id: 1, fullName: "acme/first", defaultBranch: "main" }] });
  const repo = async (githubId: number) => (await t.run((ctx) => ctx.db.query("repositories").withIndex("by_github", (q) => q.eq("githubId", githubId)).unique()))!;
  const added = (id: number, fullName: string) => t.mutation(internal.webhooks.installationEvent, { installationId: 91, action: "added", repositories: [{ id, fullName, defaultBranch: "main" }] });
  const audits = async () => (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  // Default (existing workspaces): off.
  expect((await repo(1)).enabled).toBe(false);
  await added(2, "acme/second");
  expect([(await repo(2)).enabled, (await repo(2)).indexStatus]).toEqual([false, "not_indexed"]);
  // Only admins change it; every change is audited.
  await expect(t.mutation(api.repositoryOnboarding.setAutoEnable, { token: viewer.token, organizationId, value: "on" })).rejects.toThrow();
  await expect(t.mutation(api.repositoryOnboarding.setAutoEnable, { token: admin.token, organizationId, value: "inherit" })).rejects.toThrow(/on or off/);
  await t.mutation(api.repositoryOnboarding.setAutoEnable, { token: admin.token, organizationId, value: "on" });
  expect(await audits()).toContain("repositories.auto_enable.on");
  await added(3, "acme/third");
  expect([(await repo(3)).enabled, (await repo(3)).indexStatus]).toEqual([true, "queued"]);
  expect(await audits()).toContain("repository.auto_enabled");
  // Existing repositories are untouched; re-delivered events do not flip anything.
  await added(2, "acme/second");
  expect((await repo(2)).enabled).toBe(false);
  // The install callback path applies the same setting.
  await t.mutation(api.repositories.connect, { token: admin.token, secret: "auto-service", organizationId, installationId: 91, account: "acme", accountId: 1, repositories: [{ id: 4, fullName: "acme/fourth", defaultBranch: "main" }] });
  expect((await repo(4)).enabled).toBe(true);

  // Team overrides: off beats a workspace on, on beats a workspace off, inherit follows the workspace.
  const team = await t.mutation(api.scopes.createTeam, { token: admin.token, organizationId, name: "Payments" });
  const fresh = (githubId: number) => t.run((ctx) => ctx.db.insert("repositories", { organizationId, installationId: 91, teamId: team, githubId, fullName: `acme/team-${githubId}`, defaultBranch: "main", enabled: false, indexStatus: "not_indexed", createdAt: Date.now() }));
  const enabledAfter = async (id: Id<"repositories">) => { await t.run((ctx) => autoEnableNewRepository(ctx, id)); return (await t.run((ctx) => ctx.db.get(id)))!.enabled; };
  await t.mutation(api.repositoryOnboarding.setAutoEnable, { token: admin.token, organizationId, teamId: team, value: "off" });
  expect(await enabledAfter(await fresh(10))).toBe(false);
  await t.mutation(api.repositoryOnboarding.setAutoEnable, { token: admin.token, organizationId, value: "off" });
  await t.mutation(api.repositoryOnboarding.setAutoEnable, { token: admin.token, organizationId, teamId: team, value: "on" });
  expect(await enabledAfter(await fresh(11))).toBe(true);
  await t.mutation(api.repositoryOnboarding.setAutoEnable, { token: admin.token, organizationId, teamId: team, value: "inherit" });
  expect(await enabledAfter(await fresh(12))).toBe(false);
  await added(5, "acme/fifth");
  expect((await repo(5)).enabled).toBe(false);

  // If the normal enable path refuses (installation suspended), the repository stays disabled and the refusal is audited.
  await t.mutation(api.repositoryOnboarding.setAutoEnable, { token: admin.token, organizationId, value: "on" });
  await t.run(async (ctx) => { const i = await ctx.db.query("githubInstallations").withIndex("by_installation", (q) => q.eq("installationId", 91)).unique(); await ctx.db.patch(i!._id, { active: false }); });
  await added(6, "acme/sixth");
  expect((await repo(6)).enabled).toBe(false);
  expect(await audits()).toContain("repository.auto_enable_failed");
});

test("suggested clusters: computed from indexed manifests and names, approved with one click or dismissed, never applied automatically", async () => {
  const { t, admin, viewer, organizationId } = await workspace("clusters");
  const names = ["acme/design-system", "acme/storefront", "acme/backoffice", "acme/payments-api", "acme/payments-worker", "acme/docs"];
  await t.mutation(api.repositories.connect, { token: admin.token, secret: "clusters-service", organizationId, installationId: 92, account: "acme", accountId: 1, repositories: names.map((fullName, i) => ({ id: 100 + i, fullName, defaultBranch: "main" })) });
  const repos = Object.fromEntries((await t.query(api.repositories.list, { token: admin.token, organizationId })).map((r) => [r.fullName, r._id])) as Record<string, Id<"repositories">>;
  const manifest = (fullName: string, path: string, content: string) => t.run(async (ctx) => ctx.db.insert("repositoryFiles", { organizationId, repositoryId: repos[fullName], path, sha: "s", storageId: await ctx.storage.store(new Blob([content])), language: "json", updatedAt: Date.now() }));
  await manifest("acme/design-system", "package.json", JSON.stringify({ name: "@acme/ui", dependencies: { react: "19" } }));
  await manifest("acme/storefront", "package.json", JSON.stringify({ name: "storefront", dependencies: { react: "19", "@acme/ui": "1" } }));
  await manifest("acme/backoffice", "package.json", JSON.stringify({ name: "backoffice", dependencies: { react: "19", "@acme/ui": "1" } }));
  await manifest("acme/payments-api", "go.mod", "module github.com/acme/payments-api\n\nrequire (\n\tgithub.com/stripe/stripe-go/v76 v76.0.0\n\tgithub.com/acme/ledger v1.0.0\n)\n");
  await manifest("acme/payments-worker", "go.mod", "module github.com/acme/payments-worker\n\nrequire (\n\tgithub.com/stripe/stripe-go/v76 v76.0.0\n\tgithub.com/acme/ledger v1.0.0\n)\n");
  const scan = async () => { vi.useFakeTimers(); await t.mutation(api.repositoryOnboarding.requestClusterSuggestions, { token: admin.token, organizationId }); await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync()); vi.useRealTimers(); return t.query(api.repositoryOnboarding.clusterSuggestionsPage, { token: admin.token, organizationId }); };
  await expect(t.mutation(api.repositoryOnboarding.requestClusterSuggestions, { token: viewer.token, organizationId })).rejects.toThrow();
  await expect(t.query(api.repositoryOnboarding.clusterSuggestionsPage, { token: viewer.token, organizationId })).rejects.toThrow();
  const suggestions = await scan();
  const sets = suggestions.map((s) => s.repositoryIds.map((id) => names.find((n) => repos[n] === id)).sort());
  expect(sets).toEqual(expect.arrayContaining([["acme/backoffice", "acme/design-system", "acme/storefront"], ["acme/payments-api", "acme/payments-worker"]]));
  expect(sets.length).toBe(2);
  // Nothing was applied automatically.
  expect(await t.run((ctx) => ctx.db.query("repositoryClusters").collect())).toEqual([]);
  const ui = suggestions.find((s) => s.repositoryIds.includes(repos["acme/design-system"]))!, pay = suggestions.find((s) => s.repositoryIds.includes(repos["acme/payments-api"]))!;
  expect(ui.reasons.map((r) => r.kind)).toEqual(["imports", "imports"]);
  expect(pay.reasons.map((r) => r.kind).sort()).toEqual(["dependencies", "naming"]);
  await expect(t.mutation(api.repositoryOnboarding.decideClusterSuggestion, { token: viewer.token, suggestionId: ui._id, decision: "approved" })).rejects.toThrow();
  // One click: approve (with a name edit) creates the cluster; dismiss hides the other set.
  const approved = await t.mutation(api.repositoryOnboarding.decideClusterSuggestion, { token: admin.token, suggestionId: ui._id, decision: "approved", name: "Design system" });
  const cluster = (await t.run((ctx) => ctx.db.get(approved.clusterId!)))!;
  expect([cluster.name, [...cluster.repositoryIds].sort()]).toEqual(["Design system", [...ui.repositoryIds].sort()]);
  expect((await t.mutation(api.repositoryOnboarding.decideClusterSuggestion, { token: admin.token, suggestionId: pay._id, decision: "dismissed" })).status).toBe("dismissed");
  await expect(t.mutation(api.repositoryOnboarding.decideClusterSuggestion, { token: admin.token, suggestionId: pay._id, decision: "approved" })).rejects.toThrow(/already decided/);
  // A new scan proposes neither the approved cluster nor the dismissed set.
  expect(await scan()).toEqual([]);
  const audits = (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  for (const action of ["cluster_suggestions.requested", "cluster_suggestion.approved", "cluster_suggestion.dismissed", "cluster.updated"]) expect(audits).toContain(action);
});
