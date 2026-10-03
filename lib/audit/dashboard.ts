/**
 * Audit entries for dashboard server actions (R4.6): the signed-in user acting in their org, with the request's client
 * address. Data functions shared with the REST API record nothing themselves (the API audits its own calls), so each
 * dashboard action records its own entry here after it succeeded.
 */
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { auditUserAction, type UserActor } from "@/lib/data/audit";

/** The client address of the current request (first `X-Forwarded-For` hop, as sessions record it). */
export async function requestIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

export async function dashboardActor(ctx: { orgId: string; userId: string }): Promise<UserActor> {
  return { orgId: ctx.orgId, userId: ctx.userId, ip: await requestIp() };
}

/** Records one audit entry for a dashboard action (never throws; see `auditUserAction`). */
export async function auditDashboard(
  ctx: { orgId: string; userId: string },
  entry: { action: string; targetType?: string | null; targetId?: string | number | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await auditUserAction(db(), await dashboardActor(ctx), entry);
}
