import { beforeEach, describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { SettingsFields } from "@/components/dashboard/SettingsFields";
import { activeSettingsTab, SETTINGS_TABS } from "@/components/dashboard/settings-tabs";
import { can, ROLE_DESCRIPTION, ROLES } from "@/lib/auth/permissions";
import { resolveEffectiveSettings, SETTING_DEFAULTS } from "@/lib/config/settings";
import { createInvitation, findInvitationByToken, listMembers, regenerateInvitationLink } from "@/lib/data/members";
import { deleteOrg, ensurePersonalOrg, OrgError, renameOrg } from "@/lib/data/orgs";
import type { Db } from "@/lib/db";
import { installations, llmResponseCache, modelCalls, orgs, repos, rules, sessions, usageEvents } from "@/lib/db/schema";
import { addMember, makeUser, NOW, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OrgError) return err.code;
    throw err;
  }
  throw new Error("expected the operation to be refused");
}

describe("organization settings", () => {
  test("R6.14 settings are tabbed routes (General, Review defaults, GitHub) that other sections extend", () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual(["general", "review", "github", "git-providers", "api-keys", "usage"]);
    expect(activeSettingsTab("/dashboard/settings")).toBe("general");
    expect(activeSettingsTab("/dashboard/settings/review")).toBe("review");
    expect(activeSettingsTab("/dashboard/settings/github?x=1")).toBe("github");
    expect(activeSettingsTab("/dashboard/settings/api-keys/new")).toBe("api-keys");
    const extended = [...SETTINGS_TABS, { id: "billing", label: "Billing", href: "/dashboard/settings/billing" }];
    expect(activeSettingsTab("/dashboard/settings/billing/invoices", extended)).toBe("billing");
    expect(activeSettingsTab("/dashboard/repos")).toBeNull();

    // The org-level form edits the org layer and explains it applies to every repository.
    const { settings, sources } = resolveEffectiveSettings({ mode: "deep" }, undefined, undefined);
    const html = renderToStaticMarkup(<SettingsFields scope="org" settings={settings} sources={sources} inherited={SETTING_DEFAULTS} repoSettings={{ mode: "deep" }} />);
    expect(html).toContain("Pin a model for every repository");
    expect(html).toMatch(/<option value="deep" selected="">deep<\/option>/);
  });

  test("R6.14 owners and admins rename the org; only owners delete it, with typed confirmation, and everything it owns goes with it", async () => {
    const o = await userWithOrg(db, { login: "olga", orgName: "Acme" });
    const admin = await makeUser(db, "adam");
    const member = await makeUser(db, "mo");
    await addMember(db, o.org.id, admin.id, "admin");
    await addMember(db, o.org.id, member.id, "member");
    expect(can("admin", "org.update")).toBe(true);
    expect(can("admin", "org.delete")).toBe(false);

    expect(await refused(renameOrg(db, { orgId: o.org.id, actorId: member.id, name: "Nope", slug: "nope" }))).toBe("forbidden");
    expect(await refused(renameOrg(db, { orgId: o.org.id, actorId: admin.id, name: "Acme", slug: "Bad Slug" }))).toBe("invalid_slug");
    expect(await refused(renameOrg(db, { orgId: o.org.id, actorId: admin.id, name: "", slug: "acme" }))).toBe("invalid_name");
    const renamed = await renameOrg(db, { orgId: o.org.id, actorId: admin.id, name: "Acme Engineering", slug: "acme-eng" });
    expect(renamed).toMatchObject({ name: "Acme Engineering", slug: "acme-eng" });
    const other = await userWithOrg(db, { login: "pat", orgName: "Globex" });
    expect(await refused(renameOrg(db, { orgId: other.org.id, actorId: other.user.id, name: "Globex", slug: "acme-eng" }))).toBe("slug_taken");
    expect(await refused(renameOrg(db, { orgId: o.org.id, actorId: other.user.id, name: "Hijack", slug: "hijack" }))).toBe("not_member");

    // Seed data the org owns, directly and through its repositories, plus metering rows without a foreign key.
    const [inst] = await db.insert(installations).values({ orgId: o.org.id, externalId: 4242, accountLogin: "acme" }).returning();
    const [repo] = await db.insert(repos).values({ orgId: o.org.id, installationId: inst!.id, externalId: 1, fullName: "acme/api" }).returning();
    await db.insert(rules).values({ orgId: o.org.id, repoId: repo!.id, text: "A rule for the org." });
    await db.insert(usageEvents).values({ orgId: o.org.id, kind: "review" });
    await db.insert(modelCalls).values({ orgId: o.org.id, task: "review", provider: "fake", model: "m", status: "ok" });
    await db.insert(llmResponseCache).values({ key: "k1", orgId: o.org.id, kind: "json", response: {}, usage: { inputTokens: 1, outputTokens: 1 }, expiresAt: NOW });
    await db.insert(usageEvents).values({ orgId: other.org.id, kind: "review" });

    expect(await refused(deleteOrg(db, { orgId: o.org.id, actorId: admin.id, confirm: "acme-eng" }))).toBe("forbidden");
    expect(await refused(deleteOrg(db, { orgId: o.org.id, actorId: o.user.id, confirm: "acme" }))).toBe("confirm_mismatch");
    await deleteOrg(db, { orgId: o.org.id, actorId: o.user.id, confirm: "acme-eng" });

    expect(await db.select().from(orgs).where(eq(orgs.id, o.org.id))).toEqual([]);
    expect(await db.select().from(repos)).toEqual([]);
    expect(await db.select().from(rules)).toEqual([]);
    expect(await db.select().from(modelCalls)).toEqual([]);
    expect(await db.select().from(llmResponseCache)).toEqual([]);
    expect((await db.select().from(usageEvents)).map((u) => u.orgId)).toEqual([other.org.id]);
    // Sessions that had it active are detached rather than deleted.
    const [s] = await db.select().from(sessions).where(eq(sessions.id, o.sessionId));
    expect(s?.activeOrgId).toBeNull();
  });

  test("R6.14 a personal workspace can't be deleted", async () => {
    const u = await makeUser(db, "solo");
    const personal = await ensurePersonalOrg(db, { id: u.id, name: "solo", githubLogin: "solo" });
    expect(await refused(deleteOrg(db, { orgId: personal.id, actorId: u.id, confirm: personal.slug }))).toBe("personal_delete");
  });

  test("R6.1 the team page searches members, shows last activity and role descriptions, and issues fresh invitation links", async () => {
    const o = await userWithOrg(db, { login: "olga", orgName: "Acme" });
    const zed = await makeUser(db, "zed", "zed@example.com");
    await addMember(db, o.org.id, zed.id, "member");
    await db.update(sessions).set({ lastSeenAt: NOW }).where(eq(sessions.id, o.sessionId));

    const all = await listMembers(db, o.org.id);
    expect(all.map((m) => m.name)).toEqual(["olga", "zed"]);
    expect(all.find((m) => m.name === "olga")?.lastActiveAt?.toISOString()).toBe(NOW.toISOString());
    expect(all.find((m) => m.name === "zed")?.lastActiveAt).toBeNull();
    expect((await listMembers(db, o.org.id, { query: "ZED@" })).map((m) => m.name)).toEqual(["zed"]);
    expect((await listMembers(db, o.org.id, { query: "%" }))).toEqual([]);
    for (const r of ROLES) expect(ROLE_DESCRIPTION[r].length).toBeGreaterThan(20);

    const { token, invitation } = await createInvitation(db, { orgId: o.org.id, actorId: o.user.id, target: { githubLogin: "newbie" }, role: "member", now: NOW });
    expect(await refused(regenerateInvitationLink(db, { orgId: o.org.id, actorId: zed.id, invitationId: invitation.id, now: NOW }))).toBe("forbidden");
    const later = new Date(NOW.getTime() + 86_400_000);
    const fresh = await regenerateInvitationLink(db, { orgId: o.org.id, actorId: o.user.id, invitationId: invitation.id, now: later });
    expect(fresh.token).not.toBe(token);
    expect(await findInvitationByToken(db, token)).toBeUndefined();
    const found = await findInvitationByToken(db, fresh.token);
    expect(found?.invitation.expiresAt.getTime()).toBe(later.getTime() + 7 * 86_400_000);
    // Another org's admin can't touch it.
    const other = await userWithOrg(db, { login: "pat" });
    expect(await refused(regenerateInvitationLink(db, { orgId: other.org.id, actorId: other.user.id, invitationId: invitation.id, now: later }))).toBe("not_found");
  });
});
