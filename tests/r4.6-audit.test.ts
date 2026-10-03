import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/lib/db";
import { createAuditCsvHandler } from "@/lib/audit/export";
import { auditCsvRow, csvCell, listAudit, listAuditPage, pruneAudit, recordAudit, type AuditListItem } from "@/lib/data/audit";
import { auditLog, invitations } from "@/lib/db/schema";
import { MemoryQueue } from "@/lib/jobs/types";
import { addMember, makeUser, TEST_SECRET } from "./helpers/auth";
import { dashboardFixture } from "./helpers/dashboard";

/*
 * Dashboard server actions run here with the request plumbing mocked (session, headers, redirects): the real
 * actions, data layer, and audit writes run against PGlite.
 */
const env = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  ctx: { orgId: "", userId: "", role: "owner", orgName: "Acme", orgSlug: "acme", personal: false, sessionId: "s", user: { id: "", name: "", email: null, avatarUrl: null, githubLogin: null } },
}));

vi.mock("@/lib/db", () => ({ db: () => env.db }));
vi.mock("@/lib/auth", () => ({
  requireOrg: async () => env.ctx,
  requireUser: async () => ({ id: "s", userId: env.ctx.userId, user: env.ctx.user, activeOrgId: env.ctx.orgId, ssoOrgIds: [] }),
  getSession: async () => null,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { url });
  },
  forbidden: () => {
    throw new Error("NEXT_FORBIDDEN");
  },
}));
vi.mock("@/lib/jobs/queue", () => ({ bullQueue: new MemoryQueue() }));

/** Runs a server action, swallowing the redirect it ends with. */
async function run(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("NEXT_REDIRECT"))) throw err;
  }
}

function form(fields: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
}

let fx: Awaited<ReturnType<typeof dashboardFixture>>;

beforeEach(async () => {
  fx = await dashboardFixture();
  env.db = fx.db;
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
  const owner = await makeUser(fx.db, "olivia");
  await addMember(fx.db, "org_a", owner.id, "owner");
  env.ctx = { ...env.ctx, orgId: "org_a", userId: owner.id, user: { ...env.ctx.user, id: owner.id, name: "olivia" } };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function actions(): Promise<string[]> {
  return (await listAudit(fx.db, "org_a", { limit: 500 })).map((r) => r.action);
}

describe("audit log", () => {
  test("R4.6 dashboard actions write audit entries for every admin and review category", async () => {
    const repos = await import("@/app/dashboard/repos/actions");
    const rules = await import("@/app/dashboard/rules/actions");
    const team = await import("@/app/dashboard/team/actions");
    const settings = await import("@/app/dashboard/settings/actions");
    const reviews = await import("@/app/dashboard/reviews/actions");
    const findings = await import("@/app/dashboard/findings/actions");
    const learned = await import("@/app/dashboard/learned/actions");
    const api = fx.repos.api;

    await run(() => repos.toggleRepo(form({ repoId: api.id, enabled: "false" })));
    await run(() => repos.reindexRepo(form({ repoId: api.id, kind: "full" })));
    await run(() => rules.addTemplate(form({ templateId: "billing-tests" })));
    const [rule] = (await listAudit(fx.db, "org_a", { action: "rule.created" })).map((r) => Number(r.targetId));
    await run(() => rules.toggleRule(form({ ruleId: rule!, enabled: "false" })));
    await run(() => rules.removeRule(form({ ruleId: rule! })));
    await run(() => learned.resetAllPreferences(form({})));
    await run(async () => team.inviteMember({}, form({ target: "newbie@example.com", role: "admin" })));
    const [inv] = await fx.db.select().from(invitations).where(eq(invitations.orgId, "org_a"));
    await run(() => team.revokeInvite(form({ invitationId: inv!.id })));
    const member = await makeUser(fx.db, "mia");
    await addMember(fx.db, "org_a", member.id, "member");
    await run(() => team.changeRole(form({ userId: member.id, role: "admin" })));
    await run(() => team.removeFromOrg(form({ userId: member.id })));
    await run(() => settings.renameOrganization(form({ name: "Acme Corp", slug: "acme-corp" })));
    await run(() => reviews.rerunReview(form({ reviewId: fx.reviews.r1.review.id, mode: "deep" })));
    const runId = fx.reviews.r3.run!.id;
    await run(() => reviews.cancelReviewRun(form({ runId, reviewId: fx.reviews.r3.review.id })));
    await findings.giveFindingFeedback(form({ findingId: fx.findings.fCritical.id, kind: "wont_fix" }));

    const recorded = await actions();
    for (const action of [
      "repository.disabled",
      "repository.reindex_requested",
      "rule.created",
      "rule.disabled",
      "rule.deleted",
      "preference.reset",
      "invitation.created",
      "invitation.revoked",
      "member.role_changed",
      "member.removed",
      "org.renamed",
      "review.requested",
      "review.cancelled",
      "finding.feedback_given",
    ]) {
      expect(recorded, action).toContain(action);
    }
    const rows = await listAudit(fx.db, "org_a", { limit: 500 });
    expect(rows.every((r) => r.actorType === "user" && r.actorId === env.ctx.userId && r.ip === "203.0.113.9")).toBe(true);
    expect(rows.find((r) => r.action === "member.role_changed")!.metadata).toEqual({ role: "admin" });
    expect(rows.find((r) => r.action === "org.renamed")!.metadata).toMatchObject({ to: { name: "Acme Corp", slug: "acme-corp" } });
    // Nothing was written to the other org.
    expect(await listAudit(fx.db, "org_b")).toEqual([]);
  });

  test("R4.6 SSO, model provider, and installation changes are audited", async () => {
    const { createSsoConnection, setSsoConnectionEnabled, deleteSsoConnection, parseSsoForm } = await import("@/lib/sso/connections");
    const { saveOrgLlmSettings, deleteOrgLlmSettings } = await import("@/lib/data/llm-settings");
    const actor = { orgId: "org_a", userId: env.ctx.userId };
    const f = form({ protocol: "oidc", name: "IdP", issuer: "https://idp.example.com", clientId: "c", clientSecret: "secret-value", allowedDomains: "acme.test", defaultRole: "member" });
    const conn = await createSsoConnection(fx.db, actor, parseSsoForm(f));
    await setSsoConnectionEnabled(fx.db, actor, conn.id, false);
    await deleteSsoConnection(fx.db, actor, conn.id);
    await saveOrgLlmSettings(fx.db, actor, { provider: "openai", baseUrl: null, apiKey: "sk-test-value", clearApiKey: false, model: "gpt-x", taskModels: {} }, { env: {} });
    await deleteOrgLlmSettings(fx.db, actor);
    const recorded = await actions();
    expect(recorded).toEqual(expect.arrayContaining(["sso.connection_created", "sso.connection_disabled", "sso.connection_deleted", "llm_settings.created", "llm_settings.removed"]));
    // Secrets never reach the audit trail.
    const all = JSON.stringify(await listAudit(fx.db, "org_a", { limit: 500 }));
    expect(all).not.toContain("secret-value");
    expect(all).not.toContain("sk-test-value");
  });

  test("R4.6 audit CSV export is CSV-injection-safe, filtered, and scoped to the caller's org", async () => {
    const userId = env.ctx.userId;
    await recordAudit(fx.db, { orgId: "org_a", actorType: "user", actorId: userId, action: "rule.created", metadata: { name: "=HYPERLINK(\"http://evil\")" }, targetType: "rule", targetId: "+1" });
    await recordAudit(fx.db, { orgId: "org_a", actorType: "api_key", actorId: "7", action: "review.requested", targetType: "review_run", targetId: "-5", now: new Date("2026-01-01T00:00:00Z") });
    await recordAudit(fx.db, { orgId: "org_b", actorType: "system", actorId: "github", action: "installation.removed" });

    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvCell("-2")).toBe(`"'-2"`);
    expect(csvCell("a,b")).toBe(`"a,b"`);
    expect(csvCell('say "hi"')).toBe(`"say ""hi"""`);
    expect(csvCell("plain")).toBe("plain");

    const handler = createAuditCsvHandler(() => ({
      db: fx.db,
      authorize: async () => ({ ok: true as const, ctx: { ...env.ctx, orgId: "org_a", role: "owner" as const } }),
    }));
    const res = await handler(new Request("https://review.example.com/api/orgs/current/audit.csv?orgId=org_b"));
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="audit-acme-\d{4}-\d{2}-\d{2}\.csv"$/);
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("time,actor_type,actor_id,actor_name,action,target_type,target_id,ip,metadata");
    expect(csv).not.toContain("installation.removed");
    expect(csv).toContain(`"'+1"`);
    expect(csv).toContain(`"'-5"`);
    // No cell starts with a formula character once parsed.
    expect(csv).not.toMatch(/(^|,)[=+\-@]/m);
    expect(csv).toContain("olivia");

    const filtered = await (await handler(new Request("https://review.example.com/api/orgs/current/audit.csv?action=review.*&to=2026-01-01"))).text();
    expect(filtered).toContain("review.requested");
    expect(filtered).not.toContain("rule.created");

    const denied = createAuditCsvHandler(() => ({ db: fx.db, authorize: async () => ({ ok: false as const, response: new Response("forbidden", { status: 403 }) }) }));
    expect((await denied(new Request("https://review.example.com/api/orgs/current/audit.csv"))).status).toBe(403);
    // The export itself is audited.
    expect(await actions()).toContain("audit.exported");
  });

  test("R4.6 audit log pages filter by actor, action, and date, and old entries are pruned", async () => {
    const userId = env.ctx.userId;
    for (let i = 0; i < 60; i++) {
      await recordAudit(fx.db, { orgId: "org_a", actorType: "user", actorId: userId, action: i % 2 ? "rule.created" : "repository.enabled", now: new Date(Date.UTC(2026, 0, 1 + (i % 30))) });
    }
    await recordAudit(fx.db, { orgId: "org_a", actorType: "system", actorId: "github", action: "installation.removed", now: new Date(Date.UTC(2020, 0, 1)) });
    const page1 = await listAuditPage(fx.db, "org_a", { page: 1 });
    expect(page1.total).toBe(61);
    expect(page1.items).toHaveLength(50);
    expect(page1.items[0]!.actorName).toBe("olivia");
    expect((await listAuditPage(fx.db, "org_a", { action: "rule.*" })).total).toBe(30);
    expect((await listAuditPage(fx.db, "org_a", { actorId: "github" })).total).toBe(1);
    expect((await listAuditPage(fx.db, "org_a", { from: new Date(Date.UTC(2026, 0, 29)) })).total).toBe(4);
    expect((await listAuditPage(fx.db, "org_b", {})).total).toBe(0);
    expect(await pruneAudit(fx.db, new Date(Date.UTC(2025, 0, 1)))).toBe(1);
    expect(await fx.db.select().from(auditLog).where(eq(auditLog.action, "installation.removed"))).toHaveLength(0);
    const row: AuditListItem = { ...page1.items[0]!, metadata: { note: "=cmd" } };
    expect(auditCsvRow(row)).toContain('"{""note"":""=cmd""}"');
  });
});
