import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { webhookDeliveries } from "@/lib/db/schema";
import { redact } from "@/lib/log";
import { scoped } from "./tenant";

/** A `processing` delivery younger than this is assumed to still be running; older ones crashed and are retried. */
export const IN_FLIGHT_WINDOW_MS = 5 * 60_000;
/** Largest (redacted, serialized) payload kept for replaying a failed delivery. */
export const MAX_STORED_PAYLOAD_BYTES = 1024 * 1024;

export type DeliveryStatus = (typeof webhookDeliveries.$inferSelect)["status"];

export type DeliveryClaim =
  /** First time this delivery id is seen. */
  | { kind: "new"; attempts: number }
  /** A failed or stale delivery that this caller now owns and should process again. */
  | { kind: "retry"; attempts: number }
  /** Already processed; nothing to do. */
  | { kind: "duplicate"; status: "accepted" | "ignored" }
  /** Another request is processing it right now. */
  | { kind: "in_flight" };

/**
 * Records a delivery as `processing` unless it was seen before (R1.2). The insert and the reclaim of a failed or
 * stale row are single statements, so concurrent identical deliveries cannot both win and double-enqueue.
 */
export async function claimDelivery(
  db: Db,
  input: {
    deliveryId: string;
    event: string;
    action?: string | null;
    installationId?: number;
    orgId?: string;
    payloadSha256?: string;
    now: Date;
  },
): Promise<DeliveryClaim> {
  const known = {
    ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
    ...(input.payloadSha256 !== undefined ? { payloadSha256: input.payloadSha256 } : {}),
  };
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      deliveryId: input.deliveryId,
      event: input.event,
      action: input.action ?? null,
      status: "processing",
      attempts: 1,
      receivedAt: input.now,
      lastAttemptAt: input.now,
      ...known,
    })
    .onConflictDoNothing()
    .returning({ attempts: webhookDeliveries.attempts });
  if (inserted[0]) return { kind: "new", attempts: inserted[0].attempts };

  const staleBefore = new Date(input.now.getTime() - IN_FLIGHT_WINDOW_MS);
  const reclaimed = await db
    .update(webhookDeliveries)
    .set({ status: "processing", attempts: sql`${webhookDeliveries.attempts} + 1`, lastAttemptAt: input.now, ...known })
    .where(
      and(
        eq(webhookDeliveries.deliveryId, input.deliveryId),
        or(
          eq(webhookDeliveries.status, "failed"),
          and(eq(webhookDeliveries.status, "processing"), lt(webhookDeliveries.lastAttemptAt, staleBefore)),
        ),
      ),
    )
    .returning({ attempts: webhookDeliveries.attempts });
  if (reclaimed[0]) return { kind: "retry", attempts: reclaimed[0].attempts };

  const [row] = await db
    .select({ status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, input.deliveryId));
  if (row?.status === "accepted" || row?.status === "ignored") return { kind: "duplicate", status: row.status };
  return { kind: "in_flight" };
}

export interface DeliveryContextFields {
  orgId?: string;
  installationId?: number;
  repoId?: number;
  repoFullName?: string;
}

function contextColumns(ctx: DeliveryContextFields) {
  return {
    ...(ctx.orgId !== undefined ? { orgId: ctx.orgId } : {}),
    ...(ctx.installationId !== undefined ? { installationId: ctx.installationId } : {}),
    ...(ctx.repoId !== undefined ? { repoId: ctx.repoId } : {}),
    ...(ctx.repoFullName !== undefined ? { repoFullName: ctx.repoFullName } : {}),
  };
}

/** Records a routed delivery's outcome; a stored payload from an earlier failed attempt is dropped. */
export async function finishDelivery(
  db: Db,
  deliveryId: string,
  result: DeliveryContextFields & { status: "accepted" | "ignored"; reason?: string; jobs?: string[]; durationMs: number; now: Date },
) {
  await db
    .update(webhookDeliveries)
    .set({
      status: result.status,
      reason: result.reason ?? null,
      jobs: result.jobs ?? [],
      error: null,
      payload: null,
      processedAt: result.now,
      durationMs: result.durationMs,
      ...contextColumns(result),
    })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}

/** The payload kept for a failed delivery: redacted, or null when it exceeds {@link MAX_STORED_PAYLOAD_BYTES}. */
export function storablePayload(payload: unknown): unknown {
  const redacted = redact(payload);
  const bytes = Buffer.byteLength(JSON.stringify(redacted) ?? "", "utf8");
  return bytes <= MAX_STORED_PAYLOAD_BYTES ? redacted : null;
}

/** Marks a delivery failed with its (already redacted) error and keeps the payload so it can be replayed. */
export async function failDelivery(
  db: Db,
  deliveryId: string,
  failure: DeliveryContextFields & { error: string; payload: unknown; durationMs: number; now: Date },
) {
  const payload = storablePayload(failure.payload);
  await db
    .update(webhookDeliveries)
    .set({
      status: "failed",
      error: failure.error,
      reason: payload === null ? "payload too large to keep for replay" : null,
      jobs: [],
      payload,
      processedAt: failure.now,
      durationMs: failure.durationMs,
      ...contextColumns(failure),
    })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}

const summary = {
  deliveryId: webhookDeliveries.deliveryId,
  event: webhookDeliveries.event,
  action: webhookDeliveries.action,
  installationId: webhookDeliveries.installationId,
  repoId: webhookDeliveries.repoId,
  repoFullName: webhookDeliveries.repoFullName,
  status: webhookDeliveries.status,
  reason: webhookDeliveries.reason,
  jobs: webhookDeliveries.jobs,
  error: webhookDeliveries.error,
  attempts: webhookDeliveries.attempts,
  receivedAt: webhookDeliveries.receivedAt,
  processedAt: webhookDeliveries.processedAt,
  durationMs: webhookDeliveries.durationMs,
  /** Whether a failed delivery can be replayed from its stored payload. */
  replayable: sql<boolean>`(${webhookDeliveries.status} = 'failed' and ${webhookDeliveries.payload} is not null)`,
};

/** One org's webhook deliveries, newest first (R6.21). */
export async function listDeliveries(
  db: Db,
  orgId: string,
  opts: { page?: number; pageSize?: number; status?: DeliveryStatus; repoId?: number } = {},
) {
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? 50), 1), 200);
  const page = Math.max(Math.trunc(opts.page ?? 1), 1);
  const where = scoped(
    webhookDeliveries,
    orgId,
    opts.status ? eq(webhookDeliveries.status, opts.status) : undefined,
    opts.repoId !== undefined ? eq(webhookDeliveries.repoId, opts.repoId) : undefined,
  );
  const [items, totals] = await Promise.all([
    db
      .select(summary)
      .from(webhookDeliveries)
      .where(where)
      .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.deliveryId))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(webhookDeliveries).where(where),
  ]);
  return { items, total: totals[0]?.total ?? 0, page, pageSize };
}

/** One of the org's deliveries with its stored payload (failed deliveries only), or undefined. */
export async function getDelivery(db: Db, orgId: string, deliveryId: string) {
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(scoped(webhookDeliveries, orgId, eq(webhookDeliveries.deliveryId, deliveryId)));
  return row;
}

/** Retention: deletes delivery records received before `before` across all orgs (run by the worker). */
export async function pruneDeliveries(db: Db, before: Date) {
  const rows = await db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.receivedAt, before))
    .returning({ id: webhookDeliveries.deliveryId });
  return rows.length;
}
