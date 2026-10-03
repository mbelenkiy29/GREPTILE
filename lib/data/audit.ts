/**
 * Audit trail (R4.6, R6.18). Admin actions (API key creation and revocation, ...) and review events that did not come
 * from GitHub (API-triggered reviews) are recorded with who did them, what they touched, and from where. The
 * enterprise audit log UI and CSV export read this table.
 */
import { desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { scoped } from "./tenant";

export type AuditActorType = (typeof auditLog.$inferInsert)["actorType"];
export type AuditRow = typeof auditLog.$inferSelect;

export interface AuditEntry {
  orgId: string;
  actorType: AuditActorType;
  /** User id, API key id, or a system component name. */
  actorId?: string | null;
  /** Dotted verb, e.g. `api_key.created`, `review.requested`. */
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  /** Non-secret details; never put tokens or credentials here. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
  now?: Date;
}

/** Appends one audit entry. */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<AuditRow> {
  const [row] = await db
    .insert(auditLog)
    .values({
      orgId: entry.orgId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId === undefined || entry.targetId === null ? null : String(entry.targetId),
      metadata: entry.metadata ?? {},
      ip: entry.ip?.slice(0, 64) ?? null,
      ...(entry.now ? { createdAt: entry.now } : {}),
    })
    .returning();
  return row!;
}

/** The org's most recent audit entries, newest first, optionally for one action. */
export async function listAudit(db: Db, orgId: string, opts: { action?: string; limit?: number } = {}): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(scoped(auditLog, orgId, opts.action ? eq(auditLog.action, opts.action) : undefined))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(Math.min(opts.limit ?? 100, 1000));
}
