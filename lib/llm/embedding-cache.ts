import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
}

/**
 * Embedding cache (R6.16): looks up every text's sha256 in `embedding_cache` in one batch per chunk, embeds only
 * the misses (with timeout and retries), stores them, and records the call in `model_calls` (task `embed`).
 * Duplicate texts within a call are embedded once. Cache read/write failures degrade to calling the provider.
 */
export class CachedEmbeddings implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly opts: CachedEmbeddingsOptions,
  ) {
    if (!inner.model) throw new LlmError(`embedding provider ${inner.name} must name its model to be cached`);
    this.name = inner.name;
    this.model = inner.model;
    this.now = opts.now ?? Date.now;
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
          .where(and(eq(embeddingCache.model, this.model), inArray(embeddingCache.contentHash, chunk)));
        for (const r of rows) found.set(r.hash, r.embedding.slice(0, r.dims));
      }
    } catch (err) {
      this.log.warn("embedding cache lookup failed; embedding without cache", { error: errorMessage(err) });
      found.clear();
    }
    return found;
  }

  private async store(rows: { hash: string; vector: number[] }[]): Promise<void> {
    try {
      for (let i = 0; i < rows.length; i += LOOKUP_CHUNK) {
        const chunk = rows.slice(i, i + LOOKUP_CHUNK);
        await this.opts.db
          .insert(embeddingCache)
          .values(chunk.map((r) => ({ model: this.model, contentHash: r.hash, dims: r.vector.length, embedding: toStoredEmbedding(r.vector) })))
          .onConflictDoNothing();
      }
    } catch (err) {
      this.log.warn("embedding cache write failed", { error: errorMessage(err) });
    }
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
