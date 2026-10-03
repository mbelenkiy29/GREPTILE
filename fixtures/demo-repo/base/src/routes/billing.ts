import { requireRole } from "../auth/permissions.js";
import { parseSession } from "../auth/session.js";
import { issueInvoice, type LineItem } from "../billing/invoices.js";
import type { Coupon } from "../billing/pricing.js";
import { findAccount } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { listInvoices } from "../db/invoices.js";

export interface Request {
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

export interface Response {
  status: number;
  body: unknown;
}

const COUPONS: Record<string, Coupon> = {
  LAUNCH20: { code: "LAUNCH20", percentOff: 20 },
  PARTNER35: { code: "PARTNER35", percentOff: 35 },
};

/** POST /accounts/:id/invoices — admins issue an invoice, optionally with a coupon. */
export function createInvoiceRoute(db: Db, secret: string) {
  return (req: Request): Response => {
    const session = parseSession(req.headers.authorization?.replace(/^Bearer /, ""), secret);
    if (!session) return { status: 401, body: { error: "sign in" } };
    const account = findAccount(db, req.params.id ?? "");
    if (!account) return { status: 404, body: { error: "no such account" } };
    requireRole(db, session, account.id, "admin");
    const { lines, couponCode } = req.body as { lines: LineItem[]; couponCode?: string };
    const coupon = couponCode ? (COUPONS[couponCode] ?? null) : null;
    if (couponCode && !coupon) return { status: 400, body: { error: "unknown coupon" } };
    return { status: 201, body: issueInvoice(db, account, lines, coupon) };
  };
}

/** GET /accounts/:id/invoices — any member may list invoices. */
export function listInvoicesRoute(db: Db, secret: string) {
  return (req: Request): Response => {
    const session = parseSession(req.headers.authorization?.replace(/^Bearer /, ""), secret);
    if (!session) return { status: 401, body: { error: "sign in" } };
    const accountId = req.params.id ?? "";
    requireRole(db, session, accountId, "viewer");
    return { status: 200, body: listInvoices(db, accountId) };
  };
}
