import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { ACTIONS, assignableRoles, can, type Action, type Role } from "@/lib/auth/permissions";
import { authorizeRequest, resolveOrgContext } from "@/lib/auth/request";
import { setActiveOrg, validateSessionToken } from "@/lib/auth/sessions";
import { hashToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import {
  acceptInvitation,
  acceptInvitationById,
  changeMemberRole,
  createInvitation,
  leaveOrg,
  listInvitationsForUser,
  listMembers,
  listOrgInvitations,
  parseInviteTarget,
  removeMember,
  revokeInvitation,
} from "@/lib/data/members";
import { createOrg, ensurePersonalOrg, listUserOrgs, OrgError, slugify, type OrgErrorCode } from "@/lib/data/orgs";
import { invitations, memberships, sessions } from "@/lib/db/schema";
import { addMember, makeUser, NOW, signedInCookie, testAuthConfig as config, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const DAY = 24 * 60 * 60 * 1000;

async function refused(p: Promise<unknown>): Promise<OrgErrorCode> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OrgError) return err.code;
    throw err;
  }
  throw new Error("expected the operation to be refused");
}

async function roles(orgId: string) {
  const rows = await listMembers(db, orgId);
  return Object.fromEntries(rows.map((m) => [m.name, m.role]));
}

describe("roles and permissions", () => {
  test("R6.1 permission matrix: members read, re-review, and give feedback; admins manage the org's setup; owners can do everything", () => {
    const expected: Record<Action, Role[]> = {
      "org.update": ["owner", "admin"],
      "org.delete": ["owner"],
      "billing.manage": ["owner"],
      "members.invite": ["owner", "admin"],
      "members.remove": ["owner", "admin"],
      "members.changeRole": ["owner", "admin"],
      "repos.manage": ["owner", "admin"],
      "rules.manage": ["owner", "admin"],
      "settings.manage": ["owner", "admin"],
      "apikeys.manage": ["owner", "admin"],
      "audit.read": ["owner", "admin"],
      "reviews.trigger": ["owner", "admin", "member"],
      "findings.feedback": ["owner", "admin", "member"],
    };
    expect([...ACTIONS].sort()).toEqual(Object.keys(expected).sort());
    for (const action of ACTIONS) {
      for (const role of ["owner", "admin", "member"] as const) {
        expect(can(role, action), `${role} ${action}`).toBe(expected[action].includes(role));
      }
      expect(can(undefined, action)).toBe(false);
      expect(can(null, action)).toBe(false);
    }
    expect(ACTIONS.every((a) => can("owner", a))).toBe(true);
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "member"]);
    expect(assignableRoles("admin")).toEqual(["admin", "member"]);
    expect(assignableRoles("member")).toEqual([]);
  });

  test("R6.1 route handlers get 401 when signed out and 403 without an active org or the permission", async () => {
    const owner = await userWithOrg(db, { login: "olivia" });
    const member = await makeUser(db, "mo");
    await addMember(db, owner.org.id, member.id, "member");
    const memberCookie = (await signedInCookie(db, member.id, owner.org.id)).cookie;
    const lonely = await makeUser(db, "lonely");
    const lonelyCookie = (await signedInCookie(db, lonely.id, null)).cookie;
    const deps = { db, clock: { now: NOW, ttlDays: 30 } };
    const req = (cookie?: string) => new Request(`${config.appUrl}/api/v1/repos`, { headers: cookie ? { cookie } : {} });

    const anon = await authorizeRequest(deps, req());
    expect(!anon.ok && anon.response.status).toBe(401);
    expect(!anon.ok && (await anon.response.json())).toEqual({ error: "unauthenticated" });

    const noOrg = await authorizeRequest(deps, req(lonelyCookie));
    expect(!noOrg.ok && noOrg.response.status).toBe(403);

    const denied = await authorizeRequest(deps, req(memberCookie), { permission: "repos.manage" });
    expect(!denied.ok && (await denied.response.json())).toEqual({ error: "forbidden", permission: "repos.manage" });

    const allowed = await authorizeRequest(deps, req(memberCookie), { permission: "reviews.trigger" });
    expect(allowed.ok && allowed.ctx).toMatchObject({ userId: member.id, orgId: owner.org.id, orgName: "olivia org", orgSlug: "olivia-org", role: "member" });
    const admin = await authorizeRequest(deps, req(owner.cookie), { permission: "repos.manage" });
    expect(admin.ok && admin.ctx.role).toBe("owner");
  });

  test("R6.1 every server action checks the session and the role permission it needs", () => {
    const root = path.resolve(import.meta.dirname, "../app");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /^\s*["']use server["']/.test(readFileSync(p, "utf8"))) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThanOrEqual(6);
    // Actions on the user's own memberships: membership/addressing is verified in the data layer instead of a role.
    const selfService = new Set([
      "switchOrg",
      "createOrgAction",
      "acceptListedInvitation",
      "acceptInviteAction",
      "leaveCurrentOrg",
      // Onboarding's workspace step (R6.2) does the same for a user who may not have an org yet.
      "createWorkspace",
      "chooseWorkspace",
      "acceptWorkspaceInvitation",
    ]);
    const checked: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const chunks = source.split(/\nexport async function /).slice(1);
      for (const chunk of chunks) {
        const name = chunk.slice(0, chunk.indexOf("("));
        const body = chunk.slice(0, chunk.indexOf("\n}\n") + 1 || undefined);
        const permission = /requireOrg\(\{ permission: "([\w.]+)" \}\)/.exec(body)?.[1];
        if (selfService.has(name)) {
          expect(body, `${name} must require a signed-in user`).toMatch(/require(User|Org)\(/);
        } else {
          expect(permission, `${path.relative(root, file)} ${name} must call requireOrg({ permission })`).toBeDefined();
          expect(ACTIONS).toContain(permission);
        }
        checked.push(name);
      }
    }
    expect(checked).toEqual(expect.arrayContaining(["toggleRepo", "reindexRepo", "saveRepoSettings", "saveRule", "toggleRule", "removeRule", "editPattern", "inviteMember", "changeRole", "removeFromOrg"]));
  });
});

describe("organizations", () => {
  test("R6.1 creating an org derives a unique slug and makes the creator its owner", async () => {
    const user = await makeUser(db, "casey");
    const a = await createOrg(db, { name: "  Acme   Inc. ", createdBy: user.id });
    const b = await createOrg(db, { name: "Acme Inc", createdBy: user.id });
    const c = await createOrg(db, { name: "ACME inc!", createdBy: user.id });
    expect([a.name, a.slug, b.slug, c.slug]).toEqual(["Acme Inc.", "acme-inc", "acme-inc-2", "acme-inc-3"]);
    expect(a.id).toMatch(/^org_[\w-]{16}$/);
    expect(slugify("Ünïcödé Tëam — Platform")).toBe("unicode-team-platform");
    expect(slugify("!!!")).toBe("org");
    expect(await refused(createOrg(db, { name: "   ", createdBy: user.id }))).toBe("invalid_name");
    expect(await refused(createOrg(db, { name: "x".repeat(81), createdBy: user.id }))).toBe("invalid_name");

    const personal = await ensurePersonalOrg(db, { id: user.id, name: "Casey", githubLogin: "casey" });
    expect(await ensurePersonalOrg(db, { id: user.id, name: "Casey", githubLogin: "casey" })).toEqual(personal);
    const [first, ...rest] = await listUserOrgs(db, user.id);
    expect([first?.slug, first?.role, first?.personal]).toEqual(["casey", "owner", true]);
    expect(rest.map((o) => [o.slug, o.role, o.personal]).sort()).toEqual([
      ["acme-inc", "owner", false],
      ["acme-inc-2", "owner", false],
      ["acme-inc-3", "owner", false],
    ]);
  });

  test("R6.1 switching to an org you are not a member of is denied", async () => {
    const alice = await userWithOrg(db, { login: "alice", orgName: "Alpha" });
    const bob = await userWithOrg(db, { login: "bob", orgName: "Bravo" });
    const clock = { now: NOW, ttlDays: 30 };

    expect(await setActiveOrg(db, { sessionId: alice.sessionId, userId: alice.user.id, orgId: bob.org.id })).toBe(false);
    expect((await validateSessionToken(db, alice.token, clock))?.activeOrgId).toBe(alice.org.id);
    // A session id that belongs to someone else cannot be switched either.
    expect(await setActiveOrg(db, { sessionId: bob.sessionId, userId: alice.user.id, orgId: alice.org.id })).toBe(false);
    expect((await validateSessionToken(db, bob.token, clock))?.activeOrgId).toBe(bob.org.id);

    await addMember(db, bob.org.id, alice.user.id, "member");
    expect(await setActiveOrg(db, { sessionId: alice.sessionId, userId: alice.user.id, orgId: bob.org.id })).toBe(true);
    const ctx = await resolveOrgContext(db, await validateSessionToken(db, alice.token, clock));
    expect(ctx.status === "ok" && [ctx.ctx.orgName, ctx.ctx.role]).toEqual(["Bravo", "member"]);

    // Removed members lose access to the org immediately, even with a session that still points at it.
    await removeMember(db, { orgId: bob.org.id, actorId: bob.user.id, targetUserId: alice.user.id });
    expect((await resolveOrgContext(db, await validateSessionToken(db, alice.token, clock))).status).toBe("no_org");
    await db.update(sessions).set({ activeOrgId: bob.org.id }).where(eq(sessions.id, alice.sessionId));
    expect((await resolveOrgContext(db, await validateSessionToken(db, alice.token, clock))).status).toBe("no_org");
  });
});

describe("members", () => {
  test("R6.1 the last owner cannot be removed, demoted, or leave", async () => {
    const { user: olga, org } = await userWithOrg(db, { login: "olga" });
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: olga.id, targetUserId: olga.id, role: "admin" }))).toBe("last_owner");
    expect(await refused(leaveOrg(db, { orgId: org.id, userId: olga.id }))).toBe("last_owner");
    expect(await refused(removeMember(db, { orgId: org.id, actorId: olga.id, targetUserId: olga.id }))).toBe("last_owner");

    const ada = await makeUser(db, "ada");
    await addMember(db, org.id, ada.id, "admin");
    expect(await refused(removeMember(db, { orgId: org.id, actorId: ada.id, targetUserId: olga.id }))).toBe("forbidden");
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: ada.id, targetUserId: olga.id, role: "member" }))).toBe("forbidden");
    expect(await roles(org.id)).toEqual({ olga: "owner", ada: "admin" });

    // With a second owner the first can step down; then the second is the last owner.
    await changeMemberRole(db, { orgId: org.id, actorId: olga.id, targetUserId: ada.id, role: "owner" });
    await leaveOrg(db, { orgId: org.id, userId: olga.id });
    expect(await roles(org.id)).toEqual({ ada: "owner" });
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: ada.id, targetUserId: ada.id, role: "member" }))).toBe("last_owner");
    expect(await refused(leaveOrg(db, { orgId: org.id, userId: ada.id }))).toBe("last_owner");
    expect(await refused(leaveOrg(db, { orgId: org.id, userId: olga.id }))).toBe("not_member");
  });

  test("R6.1 only owners manage owners; admins manage admins and members; members manage nobody; anyone can leave", async () => {
    const { user: owner, org } = await userWithOrg(db, { login: "owen" });
    const admin = await makeUser(db, "adam");
    const admin2 = await makeUser(db, "abby");
    const member = await makeUser(db, "mia");
    const outsider = await makeUser(db, "otto");
    await addMember(db, org.id, admin.id, "admin");
    await addMember(db, org.id, admin2.id, "admin");
    await addMember(db, org.id, member.id, "member");

    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: admin.id, targetUserId: member.id, role: "owner" }))).toBe("forbidden");
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: admin.id, targetUserId: admin.id, role: "owner" }))).toBe("forbidden");
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: member.id, targetUserId: admin2.id, role: "member" }))).toBe("forbidden");
    expect(await refused(removeMember(db, { orgId: org.id, actorId: member.id, targetUserId: admin2.id }))).toBe("forbidden");
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: outsider.id, targetUserId: member.id, role: "admin" }))).toBe("not_member");
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: owner.id, targetUserId: outsider.id, role: "admin" }))).toBe("not_found");
    expect(await refused(changeMemberRole(db, { orgId: org.id, actorId: owner.id, targetUserId: member.id, role: "superuser" }))).toBe("invalid_role");

    await changeMemberRole(db, { orgId: org.id, actorId: admin.id, targetUserId: member.id, role: "admin" });
    await changeMemberRole(db, { orgId: org.id, actorId: admin.id, targetUserId: member.id, role: "member" });
    await removeMember(db, { orgId: org.id, actorId: admin.id, targetUserId: admin2.id });
    await changeMemberRole(db, { orgId: org.id, actorId: owner.id, targetUserId: admin.id, role: "owner" });
    expect(await roles(org.id)).toEqual({ owen: "owner", adam: "owner", mia: "member" });

    await leaveOrg(db, { orgId: org.id, userId: member.id });
    expect(await roles(org.id)).toEqual({ owen: "owner", adam: "owner" });
  });

  test("R6.1 a personal workspace's creator stays its owner: nobody can remove or demote them, they cannot leave, and sign-in never re-grants access", async () => {
    const alice = await makeUser(db, "alice");
    const personal = await ensurePersonalOrg(db, { id: alice.id, name: "alice", githubLogin: "alice" });
    const bob = await makeUser(db, "bob");
    const carl = await makeUser(db, "carl");
    await addMember(db, personal.id, bob.id, "owner");
    await addMember(db, personal.id, carl.id, "admin");

    // Even with a second owner, the creator cannot be removed, demoted, or leave.
    expect(await refused(removeMember(db, { orgId: personal.id, actorId: bob.id, targetUserId: alice.id }))).toBe("personal_owner");
    expect(await refused(changeMemberRole(db, { orgId: personal.id, actorId: bob.id, targetUserId: alice.id, role: "admin" }))).toBe("personal_owner");
    expect(await refused(removeMember(db, { orgId: personal.id, actorId: carl.id, targetUserId: alice.id }))).toBe("forbidden");
    expect(await refused(leaveOrg(db, { orgId: personal.id, userId: alice.id }))).toBe("personal_owner");
    expect(await refused(removeMember(db, { orgId: personal.id, actorId: alice.id, targetUserId: alice.id }))).toBe("personal_owner");
    expect(await roles(personal.id)).toEqual({ alice: "owner", bob: "owner", carl: "admin" });
    expect((await listMembers(db, personal.id)).filter((m) => m.workspaceCreator).map((m) => m.name)).toEqual(["alice"]);

    // Everyone else in it is an ordinary member: the creator manages them and they can leave.
    await changeMemberRole(db, { orgId: personal.id, actorId: alice.id, targetUserId: bob.id, role: "admin" });
    await removeMember(db, { orgId: personal.id, actorId: alice.id, targetUserId: bob.id });
    await leaveOrg(db, { orgId: personal.id, userId: carl.id });
    expect(await roles(personal.id)).toEqual({ alice: "owner" });

    // The creator of a regular org has no special standing.
    const team = await createOrg(db, { name: "Team", createdBy: alice.id });
    await addMember(db, team.id, bob.id, "owner");
    expect((await listMembers(db, team.id)).some((m) => m.workspaceCreator)).toBe(false);
    await removeMember(db, { orgId: team.id, actorId: bob.id, targetUserId: alice.id });
    expect(await roles(team.id)).toEqual({ bob: "owner" });

    // ensurePersonalOrg runs on every sign-in and never grants a membership back, however it disappeared.
    await db.delete(memberships).where(eq(memberships.userId, alice.id));
    expect(await ensurePersonalOrg(db, { id: alice.id, name: "alice", githubLogin: "alice" })).toEqual(personal);
    expect(await listUserOrgs(db, alice.id)).toEqual([]);
  });
});

describe("invitations", () => {
  test("R6.1 invitations: accepting joins the org and switches to it; wrong user, expired, revoked, and reused links are refused", async () => {
    const owner = await userWithOrg(db, { login: "otis", orgName: "Orbit" });
    const org = owner.org;
    const ivy = await makeUser(db, "Ivy", "Ivy@Example.com");
    const mallory = await makeUser(db, "mallory");
    const ivyIdentity = { id: ivy.id, email: ivy.email, githubLogin: ivy.githubLogin };
    const member = await makeUser(db, "mem");
    await addMember(db, org.id, member.id, "member");

    expect(await refused(createInvitation(db, { orgId: org.id, actorId: member.id, target: {}, role: "member", now: NOW }))).toBe("forbidden");
    expect(await refused(createInvitation(db, { orgId: org.id, actorId: owner.user.id, target: {}, role: "owner", now: NOW }))).toBe("invalid_role");
    expect(await refused(createInvitation(db, { orgId: org.id, actorId: owner.user.id, target: parseInviteTarget("@mem"), role: "member", now: NOW }))).toBe("already_member");

    const { token, invitation } = await createInvitation(db, { orgId: org.id, actorId: owner.user.id, target: parseInviteTarget("@IVY"), role: "admin", now: NOW });
    expect(invitation).toMatchObject({ githubLogin: "ivy", email: null, role: "admin", tokenHash: hashToken(token), expiresAt: new Date(NOW.getTime() + 7 * DAY) });
    expect(JSON.stringify(await db.select().from(invitations))).not.toContain(token);
    expect((await listOrgInvitations(db, org.id, NOW)).map((i) => [i.githubLogin, i.role, i.invitedByName])).toEqual([["ivy", "admin", "otis"]]);

    expect(await refused(acceptInvitation(db, { token, user: { id: mallory.id, email: mallory.email, githubLogin: "mallory" }, now: NOW }))).toBe("wrong_user");
    expect(await refused(acceptInvitation(db, { token: "forged-token", user: ivyIdentity, now: NOW }))).toBe("invalid");
    expect(await roles(org.id)).toEqual({ otis: "owner", mem: "member" });

    // The invitee joins with the invited role and the session switches to the org.
    const ivySession = await signedInCookie(db, ivy.id, null);
    const { orgId } = await acceptInvitation(db, { token, user: ivyIdentity, now: NOW });
    expect(orgId).toBe(org.id);
    expect(await setActiveOrg(db, { sessionId: ivySession.sessionId, userId: ivy.id, orgId })).toBe(true);
    expect((await validateSessionToken(db, ivySession.token, { now: NOW, ttlDays: 30 }))?.activeOrgId).toBe(org.id);
    expect(await roles(org.id)).toEqual({ otis: "owner", Ivy: "admin", mem: "member" });
    const [accepted] = await db.select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(accepted).toMatchObject({ acceptedBy: ivy.id, acceptedAt: NOW });
    expect(await acceptInvitation(db, { token, user: ivyIdentity, now: NOW })).toEqual({ orgId: org.id });
    expect(await refused(acceptInvitation(db, { token, user: { id: mallory.id, email: null, githubLogin: "ivy" }, now: NOW }))).toBe("already_accepted");
    expect(await listOrgInvitations(db, org.id, NOW)).toEqual([]);

    // Email invitations match case-insensitively; expired and revoked links are refused.
    const byEmail = await createInvitation(db, { orgId: org.id, actorId: owner.user.id, target: parseInviteTarget("Mallory@Example.com"), role: "member", now: new Date(NOW.getTime() - 8 * DAY) });
    expect(await refused(acceptInvitation(db, { token: byEmail.token, user: { id: mallory.id, email: "mallory@example.com", githubLogin: null }, now: NOW }))).toBe("expired");
    const revoked = await createInvitation(db, { orgId: org.id, actorId: owner.user.id, target: parseInviteTarget("mallory@example.com"), role: "member", now: NOW });
    expect(await refused(revokeInvitation(db, { orgId: org.id, actorId: member.id, invitationId: revoked.invitation.id, now: NOW }))).toBe("forbidden");
    await revokeInvitation(db, { orgId: org.id, actorId: owner.user.id, invitationId: revoked.invitation.id, now: NOW });
    expect(await refused(acceptInvitation(db, { token: revoked.token, user: { id: mallory.id, email: "MALLORY@example.com", githubLogin: "mallory" }, now: NOW }))).toBe("revoked");
    // Another org cannot revoke this org's invitations.
    const other = await userWithOrg(db, { login: "zed" });
    const pendingInvite = await createInvitation(db, { orgId: org.id, actorId: owner.user.id, target: { email: "mallory@example.com" }, role: "member", now: NOW });
    expect(await refused(revokeInvitation(db, { orgId: other.org.id, actorId: other.user.id, invitationId: pendingInvite.invitation.id, now: NOW }))).toBe("not_found");

    // Pending invitations addressed to the user are listed on /orgs and can be accepted there.
    const listed = await listInvitationsForUser(db, { id: mallory.id, email: "mallory@example.com", githubLogin: "mallory" }, NOW);
    expect(listed.map((i) => [i.orgName, i.email])).toEqual([["Orbit", "mallory@example.com"]]);
    const zedIdentity = { id: other.user.id, email: other.user.email, githubLogin: other.user.githubLogin };
    expect(await refused(acceptInvitationById(db, { invitationId: pendingInvite.invitation.id, user: zedIdentity, now: NOW }))).toBe("wrong_user");
    await acceptInvitationById(db, { invitationId: pendingInvite.invitation.id, user: { id: mallory.id, email: "mallory@example.com", githubLogin: "mallory" }, now: NOW });
    expect((await roles(org.id)).mallory).toBe("member");
    expect(await listInvitationsForUser(db, { id: mallory.id, email: "mallory@example.com", githubLogin: "mallory" }, NOW)).toEqual([]);

    // Open links (no email or login) work for anyone with the link; existing members keep their role.
    const open = await createInvitation(db, { orgId: org.id, actorId: owner.user.id, target: parseInviteTarget(""), role: "admin", now: NOW });
    await acceptInvitation(db, { token: open.token, user: { id: member.id, email: null, githubLogin: "mem" }, now: NOW });
    expect((await roles(org.id)).mem).toBe("member");
    expect(await db.select().from(memberships).where(eq(memberships.userId, member.id))).toHaveLength(1);

    expect(() => parseInviteTarget("not an email@")).toThrow(OrgError);
    expect(() => parseInviteTarget("-bad-login-")).toThrow(OrgError);
    expect(parseInviteTarget("  Dev@Example.COM ")).toEqual({ email: "dev@example.com" });
  });

  test("R6.1 inviting an existing member is refused whatever the casing of their GitHub login or email", async () => {
    const owner = await userWithOrg(db, { login: "olive" });
    // Logins and emails are stored as GitHub returned them, e.g. "OctoCat".
    const octo = await makeUser(db, "OctoCat", "Octo.Cat@Example.com");
    await addMember(db, owner.org.id, octo.id, "member");
    for (const target of ["@octocat", "OCTOCAT", "OctoCat", "octo.cat@example.com", "OCTO.CAT@EXAMPLE.COM"]) {
      expect(await refused(createInvitation(db, { orgId: owner.org.id, actorId: owner.user.id, target: parseInviteTarget(target), role: "member", now: NOW }))).toBe(
        "already_member",
      );
    }
    expect(await db.select().from(invitations)).toEqual([]);
    // Someone else with a similar login can still be invited.
    await createInvitation(db, { orgId: owner.org.id, actorId: owner.user.id, target: parseInviteTarget("octocat2"), role: "member", now: NOW });
    expect(await db.select().from(invitations)).toHaveLength(1);
  });

  test("R6.1 an existing member opening an invitation link is taken to the org without using the link up", async () => {
    const owner = await userWithOrg(db, { login: "opal" });
    const mem = await makeUser(db, "mem");
    await addMember(db, owner.org.id, mem.id, "member");
    const memIdentity = { id: mem.id, email: mem.email, githubLogin: mem.githubLogin };
    const open = await createInvitation(db, { orgId: owner.org.id, actorId: owner.user.id, target: {}, role: "admin", now: NOW });

    // The member keeps their role and the link stays pending on the admins' list.
    expect(await acceptInvitation(db, { token: open.token, user: memIdentity, now: NOW })).toEqual({ orgId: owner.org.id });
    expect(await roles(owner.org.id)).toEqual({ opal: "owner", mem: "member" });
    const [untouched] = await db.select().from(invitations).where(eq(invitations.id, open.invitation.id));
    expect(untouched).toMatchObject({ acceptedAt: null, acceptedBy: null });
    expect((await listOrgInvitations(db, owner.org.id, NOW)).map((i) => i.id)).toEqual([open.invitation.id]);

    // The teammate it was meant for can still use it, and then it is spent for everyone else.
    const newbie = await makeUser(db, "newbie");
    await acceptInvitation(db, { token: open.token, user: { id: newbie.id, email: newbie.email, githubLogin: newbie.githubLogin }, now: NOW });
    expect(await roles(owner.org.id)).toEqual({ opal: "owner", mem: "member", newbie: "admin" });
    expect(await listOrgInvitations(db, owner.org.id, NOW)).toEqual([]);
    const late = await makeUser(db, "late");
    expect(await refused(acceptInvitation(db, { token: open.token, user: { id: late.id, email: late.email, githubLogin: late.githubLogin }, now: NOW }))).toBe(
      "already_accepted",
    );
    expect(await acceptInvitation(db, { token: open.token, user: memIdentity, now: NOW })).toEqual({ orgId: owner.org.id });
  });
});
