import { eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { reviewRuns } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import { pipelineEnv } from "@/lib/env";

/** First key of the two-int advisory locks the pipeline takes; keeps them apart from the indexer's ("orix"). */
export const REVIEW_LOCK_NAMESPACE = 0x6f72_7276; // "orrv"
/** Second-key offsets: one lock space for requesting runs, one for publishing, both keyed by review (PR) id. */
const REQUEST_SPACE = 0;
const PUBLISH_SPACE = 1 << 30;

export class PrLockBusyError extends Error {
  /** The worker delays the job this long instead of spending an attempt (see `retryAfterMs` in lib/jobs). */
  readonly retryAfterMs: number;
  constructor(reviewId: number, retryAfterMs = 5_000) {
    super(`another run of review ${reviewId} is publishing; retrying shortly`);
    this.name = "PrLockBusyError";
    this.retryAfterMs = retryAfterMs;
  }
}

function lockedFrom(rows: unknown): boolean {
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  const first = list[0] as { locked?: unknown } | undefined;
  return first?.locked === true || first?.locked === "t";
}

/**
 * Serializes run creation for one PR (transaction-scoped: released at commit/rollback), so concurrent deliveries
 * for the same head dedupe against each other and supersede ordering is consistent.
 */
export async function lockPrRequests(tx: Db, reviewId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${REVIEW_LOCK_NAMESPACE}::int, ${REQUEST_SPACE + (reviewId % PUBLISH_SPACE)}::int)`);
}

/**
 * Claims the PR's publishing slot (S30) and runs `claim` (the publish guard and the move to `publishing`) in one
 * short transaction. The transaction takes the per-PR publish advisory lock, so two runs never pass the guard at
 * once, and refuses while another run of the PR is `publishing` with a live heartbeat. The `publishing` status is
 * the lease from then on: the GitHub writes happen after this commits, so no row lock is held across network calls.
 * Waits up to `waitMs`, then throws {@link PrLockBusyError} (the worker retries the job later).
 */
export async function claimPublishSlot<T>(
  db: Db,
  run: { orgId: string; id: number; reviewId: number },
  claim: (tx: Db) => Promise<T>,
  opts: { waitMs?: number; pollMs?: number; staleMs?: number; now?: () => Date; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 500;
  const staleMs = opts.staleMs ?? pipelineEnv().REVIEW_STALE_MS;
  const clock = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += pollMs) {
    const outcome = await db.transaction(async (tx) => {
      const rows = await tx.execute(
        sql`select pg_try_advisory_xact_lock(${REVIEW_LOCK_NAMESPACE}::int, ${PUBLISH_SPACE + (run.reviewId % PUBLISH_SPACE)}::int) as locked`,
      );
      if (!lockedFrom(rows)) return { busy: true as const };
      const [peer] = await tx
        .select({ id: reviewRuns.id })
        .from(reviewRuns)
        .where(
          scoped(
            reviewRuns,
            run.orgId,
            eq(reviewRuns.reviewId, run.reviewId),
            ne(reviewRuns.id, run.id),
            eq(reviewRuns.status, "publishing"),
            gt(reviewRuns.heartbeatAt, new Date(clock().getTime() - staleMs)),
          ),
        )
        .limit(1);
      if (peer) return { busy: true as const };
      return { busy: false as const, value: await claim(tx) };
    });
    if (!outcome.busy) return outcome.value;
    if (waited >= waitMs) throw new PrLockBusyError(run.reviewId);
    await sleep(pollMs);
  }
}
