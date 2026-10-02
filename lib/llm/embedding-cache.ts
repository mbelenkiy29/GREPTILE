import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { embeddingCache } from "@/lib/db/schema";
import { errorMessage, log, type Logger } from "@/lib/log";
import { estimateTokens } from "./budget";
import { withRetries } from "./execute";
import { BUILTIN_PRICING, estimateCost, type PricingTable } from "./pricing";
import { recordSafely, type ModelCallRecorder, type ModelCallStatus } from "./recorder";
import { defaultSleep, type BackoffOptions } from "./retry";
import { LlmError, type EmbeddingProvider, type EmbedOptions, type Usage } from "./types";
import { toStoredEmbedding } from "./vector";

const LOOKUP_CHUNK = 500;

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface CachedEmbeddingsOptions {
  db: Db;
  recorder?: ModelCallRecorder;
  pricing?: PricingTable;
  /** Retries after the first attempt for transient provider failures (default 3). */
  maxRetries?: number;
  /** Per-attempt timeout (default 180 s). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  backoff?: BackoffOptions;
  logger?: Logger;
  /** Rows older than this are treated as misses (re-embedded and refreshed) and pruned (default 90 days). */
  ttlDays?: number;
  /** Minimum time between opportunistic prunes of expired rows (default 10 minutes). */
  pruneIntervalMs?: number;
  /** Most expired rows deleted per prune (default 500). */
  pruneBatch?: number;
}

/**
 * Embedding cache (R6.16): looks up every text's sha256 in `embedding_cache` in one batch per chunk, embeds only
 * the misses (with timeout and retries), stores them, and records the call in `model_calls` (task `embed`).
 * Duplicate texts within a call are embedded once. Cache read/write failures degrade to calling the provider.
 * Rows expire after `ttlDays`: an expired row is a miss whose re-embedding refreshes it, and expired rows are
 * pruned opportunistically as the cache is written.
 */
export class CachedEmbeddings implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly ttlMs: number;
  private lastPrune = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly opts: CachedEmbeddingsOptions,
  ) {
    if (!inner.model) throw new LlmError(`embedding provider ${inner.name} must name its model to be cached`);
    this.name = inner.name;
    this.model = inner.model;
    this.now = opts.now ?? Date.now;
    this.ttlMs = (opts.ttlDays ?? 90) * 86_400_000;
    this.log = (opts.logger ?? log).child({ component: "embeddings", model: inner.model });
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    const started = this.now();
    const hashes = texts.map(contentHash);
    const textByHash = new Map<string, string>();
    hashes.forEach((h, i) => textByHash.set(h, texts[i]!));
    const found = await this.lookup([...textByHash.keys()]);
    const misses = [...textByHash.keys()].filter((h) => !found.has(h));

    if (misses.length === 0) {
      await this.record(opts, started, "cache_hit", { inputTokens: 0, outputTokens: 0 }, 0, null);
    } else {
      const missTexts = misses.map((h) => textByHash.get(h)!);
      const outcome = await withRetries(
        (signal) => this.callProvider(missTexts, { ...opts, signal }),
        {
          maxRetries: this.opts.maxRetries ?? 3,
          timeoutMs: this.opts.timeoutMs ?? 180_000,
          sleep: this.opts.sleep ?? defaultSleep,
          backoff: this.opts.backoff,
        },
        { signal: opts.signal },
      );
      if (!outcome.ok) {
        await this.record(opts, started, "error", outcome.failedUsage, outcome.attempts, errorMessage(outcome.error));
        throw outcome.error;
      }
      const { vectors, usage } = outcome.value;
      if (vectors.length !== missTexts.length) {
        const err = new LlmError(`embedding provider returned ${vectors.length} vectors for ${missTexts.length} texts`);
        await this.record(opts, started, "error", usage, outcome.attempts, err.message);
        throw err;
      }
      misses.forEach((h, i) => found.set(h, vectors[i]!));
      await this.store(misses.map((h, i) => ({ hash: h, vector: vectors[i]! })));
      await this.record(opts, started, "ok", usage, outcome.attempts, null);
    }
    return hashes.map((h) => found.get(h)!);
  }

  private async callProvider(texts: string[], opts: EmbedOptions): Promise<{ vectors: number[][]; usage: Usage }> {
    if (this.inner.embedWithUsage) return this.inner.embedWithUsage(texts, opts);
    const vectors = await this.inner.embed(texts, opts);
    return { vectors, usage: { inputTokens: texts.reduce((n, t) => n + estimateTokens(t), 0), outputTokens: 0 } };
  }

  private async lookup(hashes: string[]): Promise<Map<string, number[]>> {
    const found = new Map<string, number[]>();
    try {
      for (let i = 0; i < hashes.length; i += LOOKUP_CHUNK) {
        const chunk = hashes.slice(i, i + LOOKUP_CHUNK);
        const rows = await this.opts.db
          .select({ hash: embeddingCache.contentHash, dims: embeddingCache.dims, embedding: embeddingCache.embedding })
          .from(embeddingCache)
          .where(
            and(
              eq(embeddingCache.model, this.model),
              inArray(embeddingCache.contentHash, chunk),
              gt(embeddingCache.createdAt, new Date(this.now() - this.ttlMs)),
            ),
          );
        for (const r of rows) found.set(r.hash, r.embedding.slice(0, r.dims));
      }
    } catch (err) {
      this.log.warn("embedding cache lookup failed; embedding without cache", { error: errorMessage(err) });
      found.clear();
    }
    return found;
  }

  private async store(rows: { hash: string; vector: number[] }[]): Promise<void> {
    const createdAt = new Date(this.now());
    try {
      for (let i = 0; i < rows.length; i += LOOKUP_CHUNK) {
        const chunk = rows.slice(i, i + LOOKUP_CHUNK);
        await this.opts.db
          .insert(embeddingCache)
          .values(
            chunk.map((r) => ({ model: this.model, contentHash: r.hash, dims: r.vector.length, embedding: toStoredEmbedding(r.vector), createdAt })),
          )
          // A miss on an expired row re-embedded it: refresh the row in place.
          .onConflictDoUpdate({
            target: [embeddingCache.model, embeddingCache.contentHash],
            set: { dims: sql`excluded.dims`, embedding: sql`excluded.embedding`, createdAt },
          });
      }
      if (createdAt.getTime() - this.lastPrune >= (this.opts.pruneIntervalMs ?? 600_000)) {
        this.lastPrune = createdAt.getTime();
        await this.prune();
      }
    } catch (err) {
      this.log.warn("embedding cache write failed", { error: errorMessage(err) });
    }
  }

  /** Deletes up to `pruneBatch` rows older than the TTL (any model); returns how many were removed. */
  async prune(): Promise<number> {
    const cutoff = new Date(this.now() - this.ttlMs);
    const expired = this.opts.db
      .select({ model: embeddingCache.model, hash: embeddingCache.contentHash })
      .from(embeddingCache)
      .where(lte(embeddingCache.createdAt, cutoff))
      .limit(this.opts.pruneBatch ?? 500);
    const deleted = await this.opts.db
      .delete(embeddingCache)
      .where(sql`(${embeddingCache.model}, ${embeddingCache.contentHash}) in ${expired}`)
      .returning({ hash: embeddingCache.contentHash });
    return deleted.length;
  }

  private async record(
    opts: EmbedOptions,
    started: number,
    status: ModelCallStatus,
    usage: Usage,
    attempts: number,
    error: string | null,
  ): Promise<void> {
    await recordSafely(
      this.opts.recorder,
      {
        orgId: opts.meta?.orgId ?? null,
        repoId: opts.meta?.repoId ?? null,
        reviewRunId: opts.meta?.reviewRunId ?? null,
        agentRunId: opts.meta?.agentRunId ?? null,
        task: "embed",
        mode: null,
        provider: this.inner.name,
        model: this.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: Math.max(0, Math.round(this.now() - started)),
        costUsd: status === "cache_hit" ? 0 : estimateCost(this.model, usage, this.opts.pricing ?? BUILTIN_PRICING),
        status,
        error,
        attempts,
      },
      this.log,
    );
  }
}
