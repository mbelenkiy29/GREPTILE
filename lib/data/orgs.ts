import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { llmResponseCache, memberships, modelCalls, orgs, sessions, usageEvents } from "@/lib/db/schema";
import { can, type Role } from "@/lib/auth/permissions";

/**
 * Organizations (workspaces) and the membership lookups that authorize every request (R6.1). Membership queries are
 * keyed by user id on purpose: they answer "which orgs may this user act in", and every tenant-owned query that
 * follows is scoped by the org id they return.
 */

export type OrgRow = typeof orgs.$inferSelect;

export interface UserOrg {
  id: string;
  name: string;
  slug: string;
  personal: boolean;
  role: Role;
}

export type OrgErrorCode =
  | "forbidden"
  | "not_member"
  | "last_owner"
  | "not_found"
  | "invalid_name"
  | "invalid_target"
  | "invalid_role"
  | "already_member"
  | "invalid"
  | "expired"
  | "revoked"
  | "already_accepted"
  | "wrong_user"
  | "personal_owner"
  | "invalid_slug"
  | "slug_taken"
  | "confirm_mismatch"
  | "personal_delete"
  | "rate_limited";

export const ORG_ERROR_MESSAGES: Record<OrgErrorCode, string> = {
  forbidden: "You don't have permission to do that.",
  not_member: "You're not a member of that organization.",
  last_owner: "Every organization needs an owner. Make someone else an owner first.",
  not_found: "That member or invitation no longer exists.",
  invalid_name: "Organization names must be 1–80 characters.",
  invalid_target: "Enter a GitHub username or an email address.",
  invalid_role: "Pick a valid role.",
  already_member: "That person is already a member.",
  invalid: "This invitation link is not valid.",
  expired: "This invitation has expired. Ask for a new one.",
  revoked: "This invitation was revoked.",
  already_accepted: "This invitation was already used.",
  wrong_user: "This invitation was sent to a different account. Sign in with the invited GitHub account or email.",
  personal_owner: "A personal workspace always belongs to the person who created it. They stay its owner and can't be removed, demoted, or leave.",
  invalid_slug: "Slugs are 1–40 lowercase letters, digits, or single dashes, and can't start or end with a dash.",
  slug_taken: "Another organization already uses that slug.",
  confirm_mismatch: "Type the organization's slug exactly to confirm.",
  personal_delete: "A personal workspace can't be deleted. Remove its repositories instead, or create another organization.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
};

/** The error code named by an untrusted value (e.g. `?error=` in a URL), or null. Only own keys match, never `constructor`. */
export function orgErrorCode(value: unknown): OrgErrorCode | null {
  return typeof value === "string" && Object.hasOwn(ORG_ERROR_MESSAGES, value) ? (value as OrgErrorCode) : null;
}

/** A refused org/membership operation. `code` is stable and safe to show (see ORG_ERROR_MESSAGES). */
export class OrgError extends Error {
  constructor(readonly code: OrgErrorCode) {
    super(ORG_ERROR_MESSAGES[code]);
  }
}

/** Unique-constraint violation from postgres-js or PGlite, optionally for one named constraint/index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown };
    if (x.code !== "23505") continue;
    if (!constraint) return true;
    const names = [x.constraint, x.constraint_name, x.message].filter((v): v is string => typeof v === "string");
    return names.some((n) => n.includes(constraint));
  }
  return false;
}

/** URL-safe slug from a display name: lowercase ASCII letters, digits, and single dashes (max 40 chars). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "org";
}

async function availableSlug(db: Db, base: string): Promise<string> {
  const rows = await db
    .select({ slug: orgs.slug })
    .from(orgs)
    .where(or(eq(orgs.slug, base), like(orgs.slug, `${base}-%`)));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  // At most taken.size - 1 numbered variants exist, so one of base-2 … base-(taken.size + 1) is free.
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 80) throw new OrgError("invalid_name");
  return trimmed;
}

/** Creates an org with a unique slug and makes `createdBy` its owner, atomically. */
export async function createOrg(
  db: Db,
  input: { name: string; createdBy: string; personal?: boolean; slugFrom?: string },
): Promise<OrgRow> {
  const name = cleanName(input.name);
  const base = slugify(input.slugFrom ?? name);
  for (let attempt = 0; ; attempt++) {
    const slug = attempt === 0 ? await availableSlug(db, base) : `${base}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    try {
      return await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(orgs)
          .values({ id: `org_${randomToken(12)}`, name, slug, personal: input.personal ?? false, createdBy: input.createdBy })
          .returning();
        await tx.insert(memberships).values({ orgId: org!.id, userId: input.createdBy, role: "owner" });
        return org!;
      });
    } catch (err) {
      // Another org took the slug between the lookup and the insert: retry with a random suffix.
      if (attempt < 3 && isUniqueViolation(err, "orgs_slug_uq")) continue;
      throw err;
    }
  }
}

/**
 * The user's personal workspace, created with its owner membership on first sign-in. An existing workspace is returned
 * as is: memberships are never granted here, so sign-in cannot restore access that was taken away. The creator cannot
 * lose that membership in the first place (see `lib/data/members.ts`), which keeps "every user has a personal
 * workspace" true.
 */
export async function ensurePersonalOrg(
  db: Db,
  user: { id: string; name: string; githubLogin?: string | null },
): Promise<OrgRow> {
  const find = async () => {
    const [row] = await db
      .select()
      .from(orgs)
      .where(and(eq(orgs.personal, true), eq(orgs.createdBy, user.id)));
    return row;
  };
  const existing = await find();
  if (existing) return existing;
  const handle = user.githubLogin || user.name || "personal";
  try {
    return await createOrg(db, { name: `${handle}'s workspace`.slice(0, 80), createdBy: user.id, personal: true, slugFrom: handle });
  } catch (err) {
    // A concurrent first sign-in created it.
    if (isUniqueViolation(err, "orgs_personal_creator_uq")) {
      const row = await find();
      if (row) return row;
    }
    throw err;
  }
}

/** Orgs the user belongs to, personal workspace first. */
export async function listUserOrgs(db: Db, userId: string): Promise<UserOrg[]> {
  return db
    .select({ id: orgs.id, name: orgs.name, slug: orgs.slug, personal: orgs.personal, role: memberships.role })
    .from(memberships)
    .innerJoin(orgs, eq(memberships.orgId, orgs.id))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(orgs.personal), asc(sql`lower(${orgs.name})`), asc(orgs.createdAt));
}

/** The user's membership in one org, with the org; undefined when they are not a member. */
export async function getMembership(db: Db, orgId: string, userId: string): Promise<UserOrg | undefined> {
  if (!orgId || !userId) return undefined;
  const [row] = await db
    .select({ id: orgs.id, name: orgs.name, slug: orgs.slug, personal: orgs.personal, role: memberships.role })
    .from(memberships)
    .innerJoin(orgs, eq(memberships.orgId, orgs.id))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  return row;
}

/**
 * Which org a new session starts in: the org the user last worked in (if still a member), else their personal
 * workspace, else their first org by name.
 */
export async function defaultOrgForUser(db: Db, userId: string): Promise<string | null> {
  const [recent] = await db
    .select({ orgId: memberships.orgId })
    .from(sessions)
    .innerJoin(memberships, and(eq(memberships.orgId, sessions.activeOrgId), eq(memberships.userId, sessions.userId)))
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.lastSeenAt))
    .limit(1);
  if (recent) return recent.orgId;
  const [first] = await listUserOrgs(db, userId);
  return first?.id ?? null;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Renames an org and/or changes its slug (Settings → General). Requires `org.update` (owners and admins), checked
 * against the acting user's membership in the database.
 */
export async function renameOrg(db: Db, input: { orgId: string; actorId: string; name: string; slug: string }): Promise<OrgRow> {
  const member = await getMembership(db, input.orgId, input.actorId);
  if (!member) throw new OrgError("not_member");
  if (!can(member.role, "org.update")) throw new OrgError("forbidden");
  const name = cleanName(input.name);
  const slug = input.slug.trim().toLowerCase();
  if (!slug || slug.length > 40 || !SLUG_PATTERN.test(slug)) throw new OrgError("invalid_slug");
  try {
    const [row] = await db.update(orgs).set({ name, slug }).where(eq(orgs.id, input.orgId)).returning();
    if (!row) throw new OrgError("not_found");
    return row;
  } catch (err) {
    if (isUniqueViolation(err, "orgs_slug_uq")) throw new OrgError("slug_taken");
    throw err;
  }
}

/**
 * Deletes an org and everything it owns (Settings → General). Owners only, never a personal workspace, and the
 * caller must type the org's slug. Tenant rows reference the org (or its repositories) with ON DELETE CASCADE;
 * the few metering tables without a foreign key are cleared explicitly in the same transaction.
 */
export async function deleteOrg(db: Db, input: { orgId: string; actorId: string; confirm: string }): Promise<void> {
  const member = await getMembership(db, input.orgId, input.actorId);
  if (!member) throw new OrgError("not_member");
  if (!can(member.role, "org.delete")) throw new OrgError("forbidden");
  if (member.personal) throw new OrgError("personal_delete");
  if (input.confirm.trim() !== member.slug) throw new OrgError("confirm_mismatch");
  await db.transaction(async (tx) => {
    await tx.delete(usageEvents).where(eq(usageEvents.orgId, input.orgId));
    await tx.delete(modelCalls).where(eq(modelCalls.orgId, input.orgId));
    await tx.delete(llmResponseCache).where(eq(llmResponseCache.orgId, input.orgId));
    await tx.delete(orgs).where(eq(orgs.id, input.orgId));
  });
}
