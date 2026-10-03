import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { can, canManageMember, INVITE_ROLES, isRole, type InviteRole, type Role } from "@/lib/auth/permissions";
import { hashToken, randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { invitations, memberships, orgs, sessions, users } from "@/lib/db/schema";
import { OrgError } from "./orgs";
import { scoped } from "./tenant";

/**
 * Team management (R6.1): members, roles, and invitations. Every function derives the acting user's role from the
 * database (never from the client), and role changes run in a transaction that locks the affected memberships and
 * all owners, so concurrent demotions cannot leave an org without an owner. The creator of a personal workspace is its
 * permanent owner: nobody can remove or demote them, and they cannot leave it.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationRow = typeof invitations.$inferSelect;

export interface MemberView {
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  githubLogin: string | null;
  role: Role;
  joinedAt: Date;
  /** This is the org's personal-workspace creator, who always stays an owner. */
  workspaceCreator: boolean;
}

export interface InvitationView {
  id: number;
  orgId: string;
  orgName: string;
  email: string | null;
  githubLogin: string | null;
  role: InviteRole;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Identity fields an invitation can be addressed to. */
export interface InviteeIdentity {
  id: string;
  email: string | null;
  githubLogin: string | null;
}

export async function listMembers(db: Db, orgId: string): Promise<MemberView[]> {
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      githubLogin: users.githubLogin,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      workspaceCreator: sql<boolean>`coalesce(${orgs.personal} and ${orgs.createdBy} = ${users.id}, false)`,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(orgs, eq(memberships.orgId, orgs.id))
    .where(scoped(memberships, orgId))
    .orderBy(asc(memberships.role), asc(users.name));
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Locks the given users' memberships and every owner membership of the org, in id order (deadlock-free), and reads
 * who created the org if it is a personal workspace (`personal` and `created_by` never change after creation).
 */
async function lockMemberships(tx: Tx, orgId: string, userIds: string[]) {
  const rows = await tx
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(scoped(memberships, orgId, or(inArray(memberships.userId, userIds), eq(memberships.role, "owner"))))
    .orderBy(asc(memberships.id))
    .for("update");
  const [org] = await tx.select({ personal: orgs.personal, createdBy: orgs.createdBy }).from(orgs).where(eq(orgs.id, orgId));
  const creator = org?.personal ? org.createdBy : null;
  return {
    find: (userId: string) => rows.find((r) => r.userId === userId),
    owners: rows.filter((r) => r.role === "owner").length,
    /** Whether `userId` created this personal workspace (and so must stay its owner). */
    isWorkspaceCreator: (userId: string) => creator !== null && creator === userId,
  };
}

async function detachSessions(tx: Tx, orgId: string, userId: string) {
  await tx
    .update(sessions)
    .set({ activeOrgId: null })
    .where(and(eq(sessions.userId, userId), eq(sessions.activeOrgId, orgId)));
}

/**
 * Changes a member's role. Only owners grant or revoke ownership; the last owner and a personal workspace's creator
 * cannot be demoted.
 */
export async function changeMemberRole(
  db: Db,
  input: { orgId: string; actorId: string; targetUserId: string; role: string },
): Promise<Role> {
  const role = input.role;
  if (!isRole(role)) throw new OrgError("invalid_role");
  return db.transaction(async (tx) => {
    const locked = await lockMemberships(tx, input.orgId, [input.actorId, input.targetUserId]);
    const actor = locked.find(input.actorId);
    if (!actor) throw new OrgError("not_member");
    const target = locked.find(input.targetUserId);
    if (!target) throw new OrgError("not_found");
    if (!canManageMember(actor.role, target.role, role)) throw new OrgError("forbidden");
    if (target.role === role) return role;
    if (role !== "owner" && locked.isWorkspaceCreator(target.userId)) throw new OrgError("personal_owner");
    if (target.role === "owner" && locked.owners <= 1) throw new OrgError("last_owner");
    await tx.update(memberships).set({ role }).where(scoped(memberships, input.orgId, eq(memberships.id, target.id)));
    return role;
  });
}

/**
 * Removes someone else from the org. Admins remove admins and members; only owners remove owners; nobody removes a
 * personal workspace's creator.
 */
export async function removeMember(db: Db, input: { orgId: string; actorId: string; targetUserId: string }): Promise<void> {
  if (input.actorId === input.targetUserId) return leaveOrg(db, { orgId: input.orgId, userId: input.actorId });
  await db.transaction(async (tx) => {
    const locked = await lockMemberships(tx, input.orgId, [input.actorId, input.targetUserId]);
    const actor = locked.find(input.actorId);
    if (!actor) throw new OrgError("not_member");
    const target = locked.find(input.targetUserId);
    if (!target) throw new OrgError("not_found");
    if (!canManageMember(actor.role, target.role, null)) throw new OrgError("forbidden");
    if (locked.isWorkspaceCreator(target.userId)) throw new OrgError("personal_owner");
    if (target.role === "owner" && locked.owners <= 1) throw new OrgError("last_owner");
    await tx.delete(memberships).where(scoped(memberships, input.orgId, eq(memberships.id, target.id)));
    await detachSessions(tx, input.orgId, input.targetUserId);
  });
}

/** Leaves an org. Anyone can leave except the last owner and the creator of a personal workspace (their own). */
export async function leaveOrg(db: Db, input: { orgId: string; userId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await lockMemberships(tx, input.orgId, [input.userId]);
    const me = locked.find(input.userId);
    if (!me) throw new OrgError("not_member");
    if (locked.isWorkspaceCreator(input.userId)) throw new OrgError("personal_owner");
    if (me.role === "owner" && locked.owners <= 1) throw new OrgError("last_owner");
    await tx.delete(memberships).where(scoped(memberships, input.orgId, eq(memberships.id, me.id)));
    await detachSessions(tx, input.orgId, input.userId);
  });
}

async function roleOf(db: Db, orgId: string, userId: string): Promise<Role | undefined> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(scoped(memberships, orgId, eq(memberships.userId, userId)));
  return row?.role;
}

const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** Parses the invite form's "GitHub username or email" field. Empty means an open link anyone can use. */
export function parseInviteTarget(raw: string): { email?: string; githubLogin?: string } {
  const value = raw.trim();
  if (!value) return {};
  if (value.includes("@") && !value.startsWith("@")) {
    if (!z.email().max(254).safeParse(value).success) throw new OrgError("invalid_target");
    return { email: value.toLowerCase() };
  }
  const login = value.replace(/^@/, "");
  if (!GITHUB_LOGIN.test(login)) throw new OrgError("invalid_target");
  return { githubLogin: login.toLowerCase() };
}

/**
 * Creates an invitation and returns the raw link token (shown once; only its hash is stored). Requires
 * `members.invite`. Invitations grant `admin` or `member` and expire after 7 days.
 */
export async function createInvitation(
  db: Db,
  input: { orgId: string; actorId: string; target: { email?: string; githubLogin?: string }; role: string; now: Date },
): Promise<{ token: string; invitation: InvitationRow }> {
  const role = input.role as InviteRole;
  if (!INVITE_ROLES.includes(role)) throw new OrgError("invalid_role");
  if (!can(await roleOf(db, input.orgId, input.actorId), "members.invite")) throw new OrgError("forbidden");
  const email = input.target.email?.toLowerCase() || null;
  const githubLogin = input.target.githubLogin?.toLowerCase() || null;
  if (email || githubLogin) {
    // Stored emails and logins keep their original casing (e.g. GitHub's "OctoCat"); compare case-insensitively.
    const matches: SQL[] = [];
    if (email) matches.push(sql`lower(${users.email}) = ${email}`);
    if (githubLogin) matches.push(sql`lower(${users.githubLogin}) = ${githubLogin}`);
    const [existing] = await db
      .select({ id: users.id })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(scoped(memberships, input.orgId, or(...matches)));
    if (existing) throw new OrgError("already_member");
  }
  const token = randomToken(32);
  const [invitation] = await db
    .insert(invitations)
    .values({
      orgId: input.orgId,
      email,
      githubLogin,
      role,
      tokenHash: hashToken(token),
      invitedBy: input.actorId,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + INVITE_TTL_MS),
    })
    .returning();
  return { token, invitation: invitation! };
}

const inviter = alias(users, "inviter");

function pending(now: Date): SQL {
  return and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now))!;
}

const invitationViewColumns = {
  id: invitations.id,
  orgId: invitations.orgId,
  orgName: orgs.name,
  email: invitations.email,
  githubLogin: invitations.githubLogin,
  role: invitations.role,
  invitedByName: inviter.name,
  createdAt: invitations.createdAt,
  expiresAt: invitations.expiresAt,
};

/** The org's pending invitations, newest first. */
export async function listOrgInvitations(db: Db, orgId: string, now: Date): Promise<InvitationView[]> {
  return db
    .select(invitationViewColumns)
    .from(invitations)
    .innerJoin(orgs, eq(invitations.orgId, orgs.id))
    .leftJoin(inviter, eq(invitations.invitedBy, inviter.id))
    .where(scoped(invitations, orgId, pending(now)))
    .orderBy(desc(invitations.createdAt));
}

/** Revokes a pending invitation (requires `members.invite`). */
export async function revokeInvitation(
  db: Db,
  input: { orgId: string; actorId: string; invitationId: number; now: Date },
): Promise<void> {
  if (!can(await roleOf(db, input.orgId, input.actorId), "members.invite")) throw new OrgError("forbidden");
  const rows = await db
    .update(invitations)
    .set({ revokedAt: input.now })
    .where(scoped(invitations, input.orgId, eq(invitations.id, input.invitationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id });
  if (!rows.length) throw new OrgError("not_found");
}

export type InvitationState = "pending" | "accepted" | "revoked" | "expired";

export function invitationState(inv: Pick<InvitationRow, "acceptedAt" | "revokedAt" | "expiresAt">, now: Date): InvitationState {
  if (inv.acceptedAt) return "accepted";
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** Whether an invitation addressed to an email and/or GitHub login was meant for this user. */
export function invitationTargetsUser(inv: Pick<InvitationRow, "email" | "githubLogin">, user: InviteeIdentity): boolean {
  if (inv.email && inv.email !== user.email?.toLowerCase()) return false;
  if (inv.githubLogin && inv.githubLogin !== user.githubLogin?.toLowerCase()) return false;
  return true;
}

/** Looks up an invitation by its link token (only the hash is compared), with the org and inviter names. */
export async function findInvitationByToken(db: Db, token: string) {
  if (!token || token.length > 200) return undefined;
  const [row] = await db
    .select({ invitation: invitations, orgName: orgs.name, invitedByName: inviter.name })
    .from(invitations)
    .innerJoin(orgs, eq(invitations.orgId, orgs.id))
    .leftJoin(inviter, eq(invitations.invitedBy, inviter.id))
    .where(eq(invitations.tokenHash, hashToken(token)));
  return row;
}

async function acceptRow(db: Db, inv: InvitationRow, user: InviteeIdentity, now: Date): Promise<{ orgId: string }> {
  // Someone who is already a member just goes to the org. The invitation is left untouched, so an open link meant
  // for a new teammate is not used up (and stays on the admins' pending list).
  if (await roleOf(db, inv.orgId, user.id)) return { orgId: inv.orgId };
  const state = invitationState(inv, now);
  if (state !== "pending") throw new OrgError(state === "accepted" ? "already_accepted" : state);
  if (!invitationTargetsUser(inv, user)) throw new OrgError("wrong_user");
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(invitations)
      .set({ acceptedAt: now, acceptedBy: user.id })
      .where(scoped(invitations, inv.orgId, eq(invitations.id, inv.id), pending(now)))
      .returning({ id: invitations.id });
    // Lost a race with another accept or a revoke.
    if (!claimed.length) throw new OrgError("already_accepted");
    // Joined concurrently through another invitation: they keep the role they already have.
    await tx.insert(memberships).values({ orgId: inv.orgId, userId: user.id, role: inv.role }).onConflictDoNothing();
    return { orgId: inv.orgId };
  });
}

/**
 * Accepts an invitation link: the token must match a pending invitation, and if the invitation names an email or
 * GitHub login it must be the signed-in user's. Creates the membership and marks the invitation accepted. A user who is
 * already a member gets the org back without consuming the invitation.
 */
export async function acceptInvitation(db: Db, input: { token: string; user: InviteeIdentity; now: Date }): Promise<{ orgId: string }> {
  const found = await findInvitationByToken(db, input.token);
  if (!found) throw new OrgError("invalid");
  return acceptRow(db, found.invitation, input.user, input.now);
}

/** Accepts an invitation listed on /orgs; only invitations addressed to this user's email or login qualify. */
export async function acceptInvitationById(
  db: Db,
  input: { invitationId: number; user: InviteeIdentity; now: Date },
): Promise<{ orgId: string }> {
  const [inv] = await db.select().from(invitations).where(eq(invitations.id, input.invitationId));
  if (!inv) throw new OrgError("invalid");
  if (!inv.email && !inv.githubLogin) throw new OrgError("wrong_user");
  return acceptRow(db, inv, input.user, input.now);
}

/** Pending invitations addressed to the user's email or GitHub login, for orgs they have not joined yet. */
export async function listInvitationsForUser(db: Db, user: InviteeIdentity, now: Date): Promise<InvitationView[]> {
  const matches: SQL[] = [];
  if (user.email) matches.push(eq(invitations.email, user.email.toLowerCase()));
  if (user.githubLogin) matches.push(eq(invitations.githubLogin, user.githubLogin.toLowerCase()));
  if (!matches.length) return [];
  const joined = db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, user.id));
  const rows = await db
    .select(invitationViewColumns)
    .from(invitations)
    .innerJoin(orgs, eq(invitations.orgId, orgs.id))
    .leftJoin(inviter, eq(invitations.invitedBy, inviter.id))
    .where(and(pending(now), or(...matches), notInArray(invitations.orgId, joined)))
    .orderBy(desc(invitations.createdAt));
  return rows.filter((r) => invitationTargetsUser(r, user));
}
