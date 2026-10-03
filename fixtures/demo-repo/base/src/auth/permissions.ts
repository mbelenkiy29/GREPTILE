import { membershipOf } from "../db/accounts.js";
import type { Db, Member } from "../db/client.js";
import type { Session } from "./session.js";

export class ForbiddenError extends Error {
  readonly status = 403;
}

const RANK: Record<Member["role"], number> = { viewer: 1, admin: 2, owner: 3 };

/** Throws ForbiddenError unless the session's user has at least `role` on the account. */
export function requireRole(db: Db, session: Session, accountId: string, role: Member["role"]): Member {
  const member = membershipOf(db, accountId, session.userId);
  if (!member || RANK[member.role] < RANK[role]) {
    throw new ForbiddenError(`requires ${role} on ${accountId}`);
  }
  return member;
}
