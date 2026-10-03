/**
 * Role-based permissions (R6.1). Every member can read everything in their org; the actions below are the
 * mutations and privileged reads that are checked server-side on every request.
 *
 * - member: trigger re-reviews and give finding feedback.
 * - admin: also manage repositories, rules, review settings, API keys, invitations, and non-owner members, rename
 *   the org, and read the audit log.
 * - owner: everything, including billing, single sign-on, deleting the org, and managing other owners.
 */

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** Roles an invitation can grant; owners are promoted after they join. */
export const INVITE_ROLES = ["admin", "member"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const ACTIONS = [
  "org.update",
  "org.delete",
  "members.invite",
  "members.remove",
  "members.changeRole",
  "repos.manage",
  "rules.manage",
  "settings.manage",
  "billing.manage",
  "apikeys.manage",
  "reviews.trigger",
  "findings.feedback",
  "audit.read",
  "sso.manage",
] as const;
export type Action = (typeof ACTIONS)[number];

const ALL: readonly Role[] = ROLES;
const ADMINS: readonly Role[] = ["owner", "admin"];
const OWNERS: readonly Role[] = ["owner"];

const MATRIX: Record<Action, readonly Role[]> = {
  "org.update": ADMINS,
  "org.delete": OWNERS,
  "billing.manage": ADMINS,
  "members.invite": ADMINS,
  "members.remove": ADMINS,
  "members.changeRole": ADMINS,
  "repos.manage": ADMINS,
  "rules.manage": ADMINS,
  "settings.manage": ADMINS,
  "apikeys.manage": ADMINS,
  "audit.read": ADMINS,
  "sso.manage": OWNERS,
  "reviews.trigger": ALL,
  "findings.feedback": ALL,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Whether `role` may perform `action`. Unknown roles can do nothing. */
export function can(role: Role | null | undefined, action: Action): boolean {
  return role != null && MATRIX[action].includes(role);
}

/**
 * Whether `actor` may move a member from `from` to `to` (or remove them when `to` is null). Admins manage admins and
 * members; only owners touch owners. The last-owner rule is enforced separately against the database.
 */
export function canManageMember(actor: Role, from: Role, to: Role | null): boolean {
  if (!can(actor, to === null ? "members.remove" : "members.changeRole")) return false;
  if (from === "owner" || to === "owner") return actor === "owner";
  return true;
}

/** Roles `actor` can assign to someone else, most privileged first. */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return ["owner", "admin", "member"];
  if (actor === "admin") return ["admin", "member"];
  return [];
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** What each role can do, in words, for the Team page. Mirrors the permission matrix above. */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Everything an admin can do, plus billing, deleting the organization, and managing other owners.",
  admin: "Manages repositories, rules, review settings, API keys, and invitations; renames the organization; manages members and admins.",
  member: "Sees everything in the organization, requests re-reviews, and gives feedback on findings.",
};
