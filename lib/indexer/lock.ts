/**
 * Per-repository index lock (R6.3): a Postgres session advisory lock keyed by (namespace, repoId), so two index runs
 * of one repository never interleave — even across worker processes and hosts.
 *
 * Session locks belong to a connection, so the lock is taken and released on one dedicated connection: a reserved
 * connection from the postgres-js pool in production. Drivers that expose a single connection (PGlite in tests) use
 * the database handle itself.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";

/** First key of the two-int advisory lock; keeps index locks apart from any other advisory lock users. */
export const INDEX_LOCK_NAMESPACE = 0x6f72_6978; // "orix"

/** Thrown when another run holds the repository's lock; the queue retries the job later. */
export class IndexLockedError extends Error {
  readonly retryable = true;
  constructor(repoId: number) {
    super(`another index run of repository ${repoId} is in progress`);
    this.name = "IndexLockedError";
  }
}

export interface LockSession {
  tryLock(key: number): Promise<boolean>;
  unlock(key: number): Promise<void>;
  release(): Promise<void>;
}

interface ReservedSql {
  unsafe(query: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  release(): void;
}

interface PostgresJsClient {
  reserve(): Promise<ReservedSql>;
}

function isPostgresJs(client: unknown): client is PostgresJsClient {
  return typeof client === "function" && typeof (client as Partial<PostgresJsClient>).reserve === "function";
}

function lockedFrom(rows: unknown): boolean {
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  const first = list[0] as { locked?: unknown } | undefined;
  return first?.locked === true || first?.locked === "t";
}

/** Opens a session on one connection for taking and releasing advisory locks. */
export async function openLockSession(db: Db): Promise<LockSession> {
  const client: unknown = (db as unknown as { $client?: unknown }).$client;
  if (isPostgresJs(client)) {
    const conn = await client.reserve();
    return {
      tryLock: async (key) => lockedFrom(await conn.unsafe("select pg_try_advisory_lock($1::int, $2::int) as locked", [INDEX_LOCK_NAMESPACE, key])),
      unlock: async (key) => {
        await conn.unsafe("select pg_advisory_unlock($1::int, $2::int)", [INDEX_LOCK_NAMESPACE, key]);
      },
      release: async () => conn.release(),
    };
  }
  return {
    tryLock: async (key) => lockedFrom(await db.execute(sql`select pg_try_advisory_lock(${INDEX_LOCK_NAMESPACE}::int, ${key}::int) as locked`)),
    unlock: async (key) => {
      await db.execute(sql`select pg_advisory_unlock(${INDEX_LOCK_NAMESPACE}::int, ${key}::int)`);
    },
    release: async () => {},
  };
}

export interface LockOptions {
  /** Attempts before giving up (default 5). */
  attempts?: number;
  /** Delay between attempts in ms (default 250). */
  delayMs?: number;
  /** Session factory (tests inject a contended lock). */
  session?: (db: Db) => Promise<LockSession>;
}

/**
 * Runs `fn` while holding the repository's index lock, retrying briefly when another run holds it. Throws
 * `IndexLockedError` (retryable) if the lock stays taken. The lock is always released.
 */
export async function withRepoIndexLock<T>(db: Db, repoId: number, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 250;
  const session = await (opts.session ?? openLockSession)(db);
  try {
    let locked = false;
    for (let i = 0; i < attempts && !locked; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
      locked = await session.tryLock(repoId);
    }
    if (!locked) throw new IndexLockedError(repoId);
    try {
      return await fn();
    } finally {
      await session.unlock(repoId);
    }
  } finally {
    await session.release();
  }
}
