import { requireRole } from "../auth/permissions.js";
import { parseSession } from "../auth/session.js";
import { findAccount, listMembers } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import type { Request, Response } from "./billing.js";

/** GET /accounts/:id/members — any member may list the account's members. */
export function listMembersRoute(db: Db, secret: string) {
  return (req: Request): Response => {
    const session = parseSession(req.headers.authorization?.replace(/^Bearer /, ""), secret);
    if (!session) return { status: 401, body: { error: "sign in" } };
    const account = findAccount(db, req.params.id ?? "");
    if (!account) return { status: 404, body: { error: "no such account" } };
    requireRole(db, session, account.id, "viewer");
    return { status: 200, body: listMembers(db, account.id) };
  };
}
