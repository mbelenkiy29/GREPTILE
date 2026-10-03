/**
 * Audit trail (R4.6, R6.18). Admin actions (repositories, settings, rules, members, invitations, API keys, SSO, model
 * provider, org changes) and review events that did not come from GitHub (dashboard / API / CLI review requests and
 * cancellations, finding status changes) are recorded with who did them, what they touched, and from where. The
 * dashboard's audit log page and the CSV export read this table; the worker prunes it after AUDIT_RETENTION_DAYS.
 */
import { count, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { auditLog, users } from "@/lib/db/schema";
import { errorMessage, log } from "@/lib/log";
import { pageWindow, toPage, type Page, type PageOptions } from "./paginate";
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

/** A signed-in user acting in their org (dashboard actions). */
export interface UserActor {
  orgId: string;
  userId: string;
  ip?: string | null;
  now?: Date;
}

/**
 * Records an action a user took from the dashboard. Audit failures are logged and never undo or fail the action
 * that already happened.
 */
export async function auditUserAction(
  db: Db,
  actor: UserActor,
  entry: { action: string; targetType?: string | null; targetId?: string | number | null; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    await recordAudit(db, { orgId: actor.orgId, actorType: "user", actorId: actor.userId, ip: actor.ip ?? null, now: actor.now, ...entry });
  } catch (err) {
    log.error("could not record an audit entry", { orgId: actor.orgId, action: entry.action, error: errorMessage(err) });
  }
}

/** Records something the system did on its own (e.g. a GitHub installation removed on GitHub). */
export async function auditSystemAction(
  db: Db,
  orgId: string,
  component: string,
  entry: { action: string; targetType?: string | null; targetId?: string | number | null; metadata?: Record<string, unknown>; now?: Date },
): Promise<void> {
  try {
    await recordAudit(db, { orgId, actorType: "system", actorId: component, ...entry });
  } catch (err) {
    log.error("could not record an audit entry", { orgId, action: entry.action, error: errorMessage(err) });
  }
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

/** Audit log filters (all optional): actor id, exact action or `prefix.*` category, and a [from, to) date range. */
export interface AuditFilter {
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

/** The action categories offered by the audit log filter. */
export const AUDIT_CATEGORIES: readonly { value: string; label: string }[] = [
  { value: "repository.*", label: "Repositories" },
  { value: "settings.*", label: "Review settings" },
  { value: "rule.*", label: "Rules" },
  { value: "preference.*", label: "Learned preferences" },
  { value: "knowledge.*", label: "Knowledge base" },
  { value: "member.*", label: "Members" },
  { value: "invitation.*", label: "Invitations" },
  { value: "api_key.*", label: "API keys" },
  { value: "sso.*", label: "Single sign-on" },
  { value: "llm_settings.*", label: "Model provider" },
  { value: "org.*", label: "Organization" },
  { value: "review.*", label: "Reviews" },
  { value: "finding.*", label: "Findings" },
  { value: "installation.*", label: "Installations" },
  { value: "delivery.*", label: "Webhook deliveries" },
];

function filterSql(f: AuditFilter): (SQL | undefined)[] {
  const action = f.action?.trim();
  let actionSql: SQL | undefined;
  if (action?.endsWith(".*")) {
    const prefix = action.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`);
    actionSql = sql`${auditLog.action} LIKE ${`${prefix}%`}`;
  } else if (action) {
    actionSql = eq(auditLog.action, action);
  }
  return [
    f.actorId ? eq(auditLog.actorId, f.actorId) : undefined,
    actionSql,
    f.from ? gte(auditLog.createdAt, f.from) : undefined,
    f.to ? lt(auditLog.createdAt, f.to) : undefined,
  ];
}

export interface AuditListItem extends AuditRow {
  /** Display name of a user actor (null for API keys, the system, and deleted users). */
  actorName: string | null;
}

async function withActorNames(db: Db, rows: AuditRow[]): Promise<AuditListItem[]> {
  const ids = [...new Set(rows.filter((r) => r.actorType === "user" && r.actorId).map((r) => r.actorId!))];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) names.set(u.id, u.name);
  }
  return rows.map((r) => ({ ...r, actorName: r.actorType === "user" && r.actorId ? (names.get(r.actorId) ?? null) : null }));
}

/** One page of the org's audit log, newest first. */
export async function listAuditPage(db: Db, orgId: string, filter: AuditFilter & PageOptions = {}): Promise<Page<AuditListItem>> {
  const win = pageWindow(filter, 50);
  const where = scoped(auditLog, orgId, ...filterSql(filter));
  const [rows, [total]] = await Promise.all([
    db.select().from(auditLog).where(where).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(win.pageSize).offset(win.offset),
    db.select({ n: count() }).from(auditLog).where(where),
  ]);
  return toPage(await withActorNames(db, rows), total?.n ?? 0, win);
}

/** Distinct actors in the org's audit log (for the actor filter), most recent first. */
export async function auditActors(db: Db, orgId: string): Promise<{ actorType: AuditActorType; actorId: string; name: string | null }[]> {
  const rows = await db
    .select({ actorType: auditLog.actorType, actorId: auditLog.actorId, last: sql<Date>`max(${auditLog.createdAt})` })
    .from(auditLog)
    .where(scoped(auditLog, orgId))
    .groupBy(auditLog.actorType, auditLog.actorId)
    .orderBy(desc(sql`max(${auditLog.createdAt})`))
    .limit(200);
  const named = await withActorNames(
    db,
    rows.filter((r) => r.actorId).map((r) => ({ actorType: r.actorType, actorId: r.actorId }) as AuditRow),
  );
  return named.map((r) => ({ actorType: r.actorType, actorId: r.actorId!, name: r.actorName }));
}

/**
 * The org's audit entries matching `filter`, newest first, in batches of `batchSize` (keyset pagination on
 * created_at + id), for streaming exports of any size without loading them all.
 */
export async function* iterateAudit(db: Db, orgId: string, filter: AuditFilter = {}, batchSize = 500): AsyncGenerator<AuditListItem[]> {
  let cursor: number | null = null;
  for (;;) {
    const after: SQL | undefined = cursor !== null
      ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (SELECT c.created_at, c.id FROM audit_log c WHERE c.id = ${cursor})`
      : undefined;
    const rows: AuditRow[] = await db
      .select()
      .from(auditLog)
      .where(scoped(auditLog, orgId, ...filterSql(filter), after))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(batchSize);
    if (!rows.length) return;
    yield await withActorNames(db, rows);
    if (rows.length < batchSize) return;
    const last: AuditRow = rows[rows.length - 1]!;
    cursor = last.id;
  }
}

/**
 * One CSV cell (RFC 4180 quoting), made safe for spreadsheets: a value starting with `=`, `+`, `-`, `@`, a tab, or a
 * carriage return is prefixed with `'` so it is never evaluated as a formula (CSV injection).
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

export const AUDIT_CSV_COLUMNS = ["time", "actor_type", "actor_id", "actor_name", "action", "target_type", "target_id", "ip", "metadata"] as const;

export function auditCsvRow(r: AuditListItem): string {
  return [r.createdAt, r.actorType, r.actorId, r.actorName, r.action, r.targetType, r.targetId, r.ip, r.metadata].map(csvCell).join(",");
}

/** The org's audit log as a CSV byte stream (header + one row per entry), read in batches. */
export function auditCsvStream(db: Db, orgId: string, filter: AuditFilter = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const batches = iterateAudit(db, orgId, filter);
  let headerSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(encoder.encode(`${AUDIT_CSV_COLUMNS.join(",")}\r\n`));
        return;
      }
      try {
        const next = await batches.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value.map((r) => `${auditCsvRow(r)}\r\n`).join("")));
      } catch (err) {
        log.error("audit CSV export failed", { orgId, error: errorMessage(err) });
        controller.error(new Error("audit export failed"));
      }
    },
    async cancel() {
      await batches.return(undefined);
    },
  });
}

/** Deletes audit entries older than `before` (all orgs), in batches. Returns how many were removed. */
export async function pruneAudit(db: Db, before: Date, batch = 5_000): Promise<number> {
  let removed = 0;
  for (;;) {
    const old = db.select({ id: auditLog.id }).from(auditLog).where(lt(auditLog.createdAt, before)).limit(batch);
    const rows = await db.delete(auditLog).where(inArray(auditLog.id, old)).returning({ id: auditLog.id });
    removed += rows.length;
    if (rows.length < batch) return removed;
  }
}
