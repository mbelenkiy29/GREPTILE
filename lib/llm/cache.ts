import { createHash } from "node:crypto";
import { and, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { llmResponseCache } from "@/lib/db/schema";
import type { Usage } from "./types";

/**
 * Response cache (R6.16). Only calls that pass `cache: true` use it. The key covers everything that determines the
 * answer, so a hit is a response the same model already gave to the same instructions and input.
 */

export type CachedKind = "json" | "text";

export interface CachedResponse {
  kind: CachedKind;
  response: unknown;
  /** Tokens the original call spent (a hit spends none). */
  usage: Usage;
}

export interface ResponseCache {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, entry: CachedResponse): Promise<void>;
}

export interface ResponseCacheKeyParts {
  kind: CachedKind;
  provider: string;
  /** Endpoint for OpenAI-style providers: the same model name on two servers is two models. */
  baseURL?: string;
  model: string;
  task: string | null;
  effort?: string;
  system: string;
  prompt: string;
  schemaName?: string;
  jsonSchema?: unknown;
}

/** sha256 over an unambiguous encoding of every part (a JSON array, so no delimiter collisions). */
export function responseCacheKey(p: ResponseCacheKeyParts): string {
  const encoded = JSON.stringify([
    "v1",
    p.kind,
    p.provider,
    p.baseURL ?? "",
    p.model,
    p.task ?? "",
    p.effort ?? "",
    p.system,
    p.prompt,
    p.schemaName ?? "",
    p.jsonSchema ?? null,
  ]);
  return createHash("sha256").update(encoded).digest("hex");
}

const storedResponse = z.object({ value: z.unknown() });
const storedUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
});

export interface PostgresResponseCacheOptions {
  ttlHours: number;
  now?: () => number;
  /** Minimum time between opportunistic prunes of expired rows (default 10 minutes). */
  pruneIntervalMs?: number;
  /** Most expired rows deleted per prune (default 500). */
  pruneBatch?: number;
}

/** `llm_response_cache` in Postgres. Expired rows are never served and are pruned as the cache is written. */
export class PostgresResponseCache implements ResponseCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly pruneIntervalMs: number;
  private readonly pruneBatch: number;
  private lastPrune = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: Db,
    opts: PostgresResponseCacheOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlHours * 3_600_000;
    this.pruneIntervalMs = opts.pruneIntervalMs ?? 600_000;
    this.pruneBatch = opts.pruneBatch ?? 500;
  }

  async get(key: string): Promise<CachedResponse | null> {
    const now = new Date(this.now());
    const [row] = await this.db.select().from(llmResponseCache).where(eq(llmResponseCache.key, key)).limit(1);
    if (!row) return null;
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.db.delete(llmResponseCache).where(and(eq(llmResponseCache.key, key), lte(llmResponseCache.expiresAt, now)));
      return null;
    }
    const response = storedResponse.safeParse(row.response);
    const usage = storedUsage.safeParse(row.usage);
    if (!response.success || !usage.success || (row.kind !== "json" && row.kind !== "text")) return null;
    return { kind: row.kind, response: response.data.value, usage: usage.data };
  }

  async set(key: string, entry: CachedResponse): Promise<void> {
    const now = this.now();
    const values = {
      kind: entry.kind,
      response: { value: entry.response },
      usage: entry.usage,
      createdAt: new Date(now),
      expiresAt: new Date(now + this.ttlMs),
    };
    await this.db
      .insert(llmResponseCache)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: llmResponseCache.key, set: values });
    if (now - this.lastPrune >= this.pruneIntervalMs) {
      this.lastPrune = now;
      await this.prune();
    }
  }

  /** Deletes up to `pruneBatch` expired rows; returns how many were removed. */
  async prune(): Promise<number> {
    const now = new Date(this.now());
    const expired = this.db
      .select({ key: llmResponseCache.key })
      .from(llmResponseCache)
      .where(lte(llmResponseCache.expiresAt, now))
      .limit(this.pruneBatch);
    const deleted = await this.db
      .delete(llmResponseCache)
      .where(inArray(llmResponseCache.key, expired))
      .returning({ key: llmResponseCache.key });
    return deleted.length;
  }
}
