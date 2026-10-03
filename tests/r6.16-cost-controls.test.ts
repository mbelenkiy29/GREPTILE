import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { embeddingCache, llmResponseCache, modelCalls } from "@/lib/db/schema";
import { estimateTokens, fitItemsToBudget, truncateToTokens } from "@/lib/llm/budget";
import { PostgresResponseCache, responseCacheKey, type ResponseCacheKeyParts } from "@/lib/llm/cache";
import { CachedEmbeddings, contentHash } from "@/lib/llm/embedding-cache";
import { AnthropicProvider, type AnthropicMessagesApi } from "@/lib/llm/anthropic";
import { FakeEmbeddings, FakeLlm } from "@/lib/llm/fake";
import { createGateway } from "@/lib/llm/gateway";
import { OpenAiCompatibleEmbeddings, OpenAiCompatibleProvider } from "@/lib/llm/openai";
import { BUILTIN_PRICING, estimateCost, pricingTable } from "@/lib/llm/pricing";
import { InMemoryModelCallRecorder, PostgresModelCallRecorder, modelCallTotals } from "@/lib/llm/recorder";
import { LlmError, type LlmProvider } from "@/lib/llm/types";
import { createTestDb } from "./helpers/db";
import { anthropicMessage, chatCompletion, fakeFetch, jsonResponse } from "./helpers/fake-fetch";
import { seedReviewRuns } from "./helpers/review-runs";

/** FakeEmbeddings that remembers which texts reached the "provider". */
class CountingEmbeddings extends FakeEmbeddings {
  readonly batches: string[][] = [];
  override async embed(texts: string[]) {
    this.batches.push(texts);
    return super.embed(texts);
  }
}

function expectVectorsClose(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => {
    expect(v).toHaveLength(expected[i]!.length);
    v.forEach((x, j) => expect(x).toBeCloseTo(expected[i]![j]!, 6));
  });
}

const verdictSchema = z.object({ verdict: z.enum(["keep", "drop"]) });
const HOUR = 3_600_000;

describe("embedding cache", () => {
  test("R6.16 embedding cache: repeated texts are served from the cache without calling the provider", async () => {
    const db = await createTestDb();
    const inner = new CountingEmbeddings(64);
    const recorder = new InMemoryModelCallRecorder();
    const cached = new CachedEmbeddings(inner, { db, recorder });
    const reference = new FakeEmbeddings(64);

    const first = await cached.embed(["function computeTotal", "class Cart", "function computeTotal"], { meta: { orgId: "org_a", repoId: 1 } });
    expect(inner.batches).toEqual([["function computeTotal", "class Cart"]]);
    expect(first).toEqual(await reference.embed(["function computeTotal", "class Cart", "function computeTotal"]));
    expect(first[0]).toHaveLength(64);

    const second = await cached.embed(["class Cart", "def build_report"]);
    expect(inner.batches[1]).toEqual(["def build_report"]);
    // Hits come back from pgvector (single precision); misses are the provider's own vectors.
    expectVectorsClose(second, await reference.embed(["class Cart", "def build_report"]));

    await cached.embed(["class Cart", "function computeTotal"]);
    expect(inner.batches).toHaveLength(2);

    const rows = await db.select().from(embeddingCache).where(eq(embeddingCache.model, "fake-embedding-64"));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.dims === 64 && r.embedding.length === 1536)).toBe(true);
    expect(recorder.calls.map((c) => [c.task, c.status, c.model])).toEqual([
      ["embed", "ok", "fake-embedding-64"],
      ["embed", "ok", "fake-embedding-64"],
      ["embed", "cache_hit", "fake-embedding-64"],
    ]);
    expect(recorder.calls[0]).toMatchObject({ orgId: "org_a", repoId: 1, inputTokens: estimateTokens("function computeTotal") + estimateTokens("class Cart") });
    expect(recorder.calls[2]).toMatchObject({ inputTokens: 0, costUsd: 0, attempts: 0 });
    // Another model never reads these rows.
    const other = new CountingEmbeddings(32);
    await new CachedEmbeddings(other, { db }).embed(["class Cart"]);
    expect(other.batches).toEqual([["class Cart"]]);
  });

  test("R6.16 cached OpenAI embeddings are priced from provider usage and retried on transient errors", async () => {
    const db = await createTestDb();
    const http = fakeFetch((req, i) => {
      if (i === 0) return jsonResponse({ error: { message: "rate limited" } }, 429);
      const input = (req.body as { input: string[] }).input;
      return jsonResponse({
        data: input.map((_, index) => ({ index, embedding: [index + 1, 0.5, 0.25] })).reverse(),
        usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
      });
    });
    const inner = new OpenAiCompatibleEmbeddings({ flavor: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-test", model: "text-embedding-3-small", fetch: http.fetch });
    const recorder = new PostgresModelCallRecorder(db);
    const cached = new CachedEmbeddings(inner, { db, recorder, sleep: async () => undefined });
    expect(await cached.embed(["a", "b"], { meta: { orgId: "org_a" } })).toEqual([
      [1, 0.5, 0.25],
      [2, 0.5, 0.25],
    ]);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(http.requests[1]!.headers.authorization).toBe("Bearer sk-test");
    expect(http.requests[1]!.body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] });
    const [row] = await db.select().from(modelCalls);
    expect(row).toMatchObject({ task: "embed", provider: "openai", model: "text-embedding-3-small", inputTokens: 1_000_000, costUsd: 0.02, attempts: 2, status: "ok" });
    expect(await cached.embed(["b"])).toEqual([[2, 0.5, 0.25]]);
    expect(http.requests).toHaveLength(2);
  });
});

describe("response cache", () => {
  test("R6.16 response cache: an identical cached call is a hit, other calls miss, and expired entries are ignored", async () => {
    const db = await createTestDb();
    let clock = Date.parse("2026-10-01T00:00:00Z");
    const now = () => clock;
    let n = 0;
    const fake = new FakeLlm((call) => (call.kind === "json" ? { verdict: n++ % 2 === 0 ? "keep" : "drop" } : `answer ${n++}`));
    const recorder = new PostgresModelCallRecorder(db);
    const cache = new PostgresResponseCache(db, { ttlHours: 2, now });
    const g = createGateway({ env: { LLM_PROVIDER: "anthropic" }, provider: fake, recorder, cache, now });
    const ask = (prompt: string, extra: { cache?: boolean } = { cache: true }) =>
      g.json({ system: "Verify the finding.", prompt, schema: verdictSchema, schemaName: "verdict", task: "verify", meta: { orgId: "org_a" }, ...extra });

    const miss = await ask("finding 1");
    expect(miss).toMatchObject({ data: { verdict: "keep" }, cached: false, attempts: 1 });
    const hit = await ask("finding 1");
    expect(hit).toMatchObject({ data: { verdict: "keep" }, cached: true, attempts: 0, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(hit.route).toMatchObject({ task: "verify", model: "claude-opus-5-5" });
    expect(fake.calls).toHaveLength(1);

    await ask("finding 2");
    expect(fake.calls).toHaveLength(2);
    // Without `cache: true` the cache is neither read nor written.
    await ask("finding 1", { cache: false });
    expect(fake.calls).toHaveLength(3);
    // A different route (deep verify uses another effort) is a different key.
    await g.json({ system: "Verify the finding.", prompt: "finding 1", schema: verdictSchema, schemaName: "verdict", task: "verify", mode: "deep", cache: true });
    expect(fake.calls).toHaveLength(4);
    // Text calls are cached separately from JSON calls.
    const t1 = await g.text({ system: "Explain.", prompt: "why", task: "chat", cache: true });
    const t2 = await g.text({ system: "Explain.", prompt: "why", task: "chat", cache: true });
    expect(t2).toMatchObject({ text: t1.text, cached: true });
    expect(fake.calls).toHaveLength(5);

    clock += 2 * HOUR + 1;
    const afterExpiry = await ask("finding 1");
    expect(afterExpiry.cached).toBe(false);
    expect(fake.calls).toHaveLength(6);
    expect(await ask("finding 1")).toMatchObject({ cached: true });

    const rows = await db.select().from(modelCalls).where(eq(modelCalls.status, "cache_hit"));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.costUsd === 0 && r.inputTokens === 0 && r.attempts === 0)).toBe(true);
  });

  test("R6.16 expired cache rows are never served and are pruned; schema changes invalidate hits", async () => {
    const db = await createTestDb();
    let clock = 1_000_000;
    const cache = new PostgresResponseCache(db, { ttlHours: 1, now: () => clock, pruneIntervalMs: 0 });
    await cache.set("k1", { kind: "json", response: { verdict: "keep" }, usage: { inputTokens: 10, outputTokens: 2 } });
    expect(await cache.get("k1")).toEqual({ kind: "json", response: { verdict: "keep" }, usage: { inputTokens: 10, outputTokens: 2 } });
    clock += HOUR;
    expect(await cache.get("k1")).toBeNull();
    expect(await db.select().from(llmResponseCache)).toHaveLength(0);

    await cache.set("k2", { kind: "text", response: "old", usage: { inputTokens: 1, outputTokens: 1 } });
    clock += 2 * HOUR;
    await cache.set("k3", { kind: "text", response: "new", usage: { inputTokens: 1, outputTokens: 1 } });
    expect((await db.select().from(llmResponseCache)).map((r) => r.key)).toEqual(["k3"]);
    expect(await cache.prune()).toBe(0);

    // A cached answer that no longer satisfies the caller's schema is treated as a miss.
    const fake = new FakeLlm(() => ({ verdict: "drop" }));
    const g = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: fake, cache, now: () => clock });
    const req = { system: "s", prompt: "p", schema: verdictSchema, schemaName: "verdict", cache: true };
    const key = responseCacheKey({
      kind: "json",
      provider: "fake",
      model: "fake-model",
      task: null,
      maxTokens: 16_000,
      system: "s",
      prompt: "p",
      schemaName: "verdict",
      jsonSchema: z.toJSONSchema(verdictSchema, { io: "input", unrepresentable: "any" }),
    });
    await cache.set(key, { kind: "json", response: { verdict: "maybe" }, usage: { inputTokens: 1, outputTokens: 1 } });
    expect(await g.json(req)).toMatchObject({ data: { verdict: "drop" }, cached: false });
    expect(await g.json(req)).toMatchObject({ data: { verdict: "drop" }, cached: true });
    expect(fake.calls).toHaveLength(1);
  });

  test("R6.16 response cache keys cover org, provider, endpoint, model, task, effort, output limit, prompts, and schema", () => {
    const base: ResponseCacheKeyParts = {
      kind: "json",
      provider: "anthropic",
      model: "claude-opus-5-5",
      task: "verify",
      effort: "medium",
      system: "sys",
      prompt: "prompt",
      schemaName: "verdict",
      jsonSchema: { type: "object" },
    };
    const key = responseCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(responseCacheKey({ ...base })).toBe(key);
    const variants: Partial<ResponseCacheKeyParts>[] = [
      { kind: "text" },
      { provider: "openai-compatible" },
      { baseURL: "http://other:8000/v1" },
      { model: "claude-sonnet-5-5" },
      { task: "review" },
      { effort: "high" },
      { maxTokens: 4_000 },
      { orgId: "org_b" },
      { system: "sys2" },
      { prompt: "prompt2" },
      { schemaName: "other" },
      { jsonSchema: { type: "array" } },
    ];
    for (const v of variants) expect(responseCacheKey({ ...base, ...v })).not.toBe(key);
    // Field boundaries are unambiguous.
    expect(responseCacheKey({ ...base, system: "a|b", prompt: "c" })).not.toBe(responseCacheKey({ ...base, system: "a", prompt: "b|c" }));
  });
});

describe("cost and budgets", () => {
  test("R6.16 estimates cost from the pricing table, returns null for unknown models, and honors LLM_PRICING_JSON", async () => {
    const mtok = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(estimateCost("claude-opus-5-5", mtok)).toBe(29.2);
    expect(estimateCost("claude-fable-5-1", mtok)).toBe(73.5);
    expect(estimateCost("claude-opus-5", mtok)).toBe(36.75);
    expect(estimateCost("claude-sonnet-5-5", mtok)).toBe(14.7);
    expect(estimateCost("claude-sonnet-5", mtok)).toBe(14.7);
    expect(estimateCost("claude-haiku-4-5", mtok)).toBe(7.35);
    expect(estimateCost("text-embedding-3-large", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.13);
    expect(estimateCost("claude-haiku-4-5", { inputTokens: 1_234, outputTokens: 56 })).toBe(0.001514);
    expect(estimateCost("some-local-model", mtok)).toBeNull();

    const table = pricingTable(JSON.stringify({ "local-coder": { input: 0.5, output: 1.5 }, "claude-haiku-4-5": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2.5 } }));
    expect(estimateCost("local-coder", mtok, table)).toBe(0.5 + 1.5 + 0.5 + 0.5);
    expect(estimateCost("claude-haiku-4-5", mtok, table)).toBe(10.7);
    expect(estimateCost("claude-opus-5-5", mtok, table)).toBe(29.2);
    expect(BUILTIN_PRICING["claude-haiku-4-5"]!.input).toBe(1);
    expect(() => pricingTable("{not json")).toThrow(LlmError);
    expect(() => pricingTable(JSON.stringify({ m: { input: -1 } }))).toThrow(/LLM_PRICING_JSON is invalid/);

    const recorder = new InMemoryModelCallRecorder();
    const fake = new FakeLlm(() => "x");
    const g = createGateway({
      env: { LLM_PROVIDER: "fake", LLM_PRICING_JSON: JSON.stringify({ "fake-model": { input: 1_000_000, output: 0 } }) },
      provider: fake,
      recorder,
    });
    await g.text({ system: "abcd", prompt: "efgh" });
    expect(recorder.calls[0]).toMatchObject({ model: "fake-model", inputTokens: 2, costUsd: 2 });
    const unpriced = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: fake, recorder });
    await unpriced.text({ system: "abcd", prompt: "efgh" });
    expect(recorder.calls[1]!.costUsd).toBeNull();
    expect(recorder.totals()).toMatchObject({ calls: 2, costUsd: 2, unpricedCalls: 1 });
  });

  test("R6.16 estimated model cost is totalled per pull-request review run and scoped to the org", async () => {
    const db = await createTestDb();
    const recorder = new PostgresModelCallRecorder(db);
    const [run1, run2] = (await seedReviewRuns(db, "org_a", 2)) as [number, number];
    const row = (orgId: string | null, reviewRunId: number | null, costUsd: number | null, status: "ok" | "cache_hit" = "ok") =>
      recorder.record({
        orgId,
        repoId: 1,
        reviewRunId,
        agentRunId: null,
        task: "review",
        mode: "standard",
        provider: "anthropic",
        model: "claude-opus-5-5",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
        latencyMs: 50,
        costUsd,
        status,
        error: null,
        attempts: 1,
      });
    await row("org_a", run1, 0.25);
    await row("org_a", run1, 0.125);
    await row("org_a", run1, 0, "cache_hit");
    await row("org_a", run1, null);
    await row("org_a", run2, 1);
    await row("org_b", run1, 9);
    await row(null, run1, 9);
    expect(await modelCallTotals(db, "org_a", { reviewRunId: run1 })).toEqual({
      calls: 4,
      inputTokens: 400,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheWriteTokens: 4,
      costUsd: 0.375,
      unpricedCalls: 1,
    });
    expect((await modelCallTotals(db, "org_a")).costUsd).toBe(1.375);
    expect((await modelCallTotals(db, "org_b", { reviewRunId: run2 })).calls).toBe(0);
    expect((await modelCallTotals(db, "org_a", { since: new Date(Date.now() + HOUR) })).calls).toBe(0);
    await expect(modelCallTotals(db, "")).rejects.toThrow(/orgId/);
  });

  test("R6.16 budget helpers estimate tokens, truncate on line boundaries with a marker, and fit items greedily", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);

    const text = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, "0")} ${"x".repeat(20)}`).join("\n");
    expect(truncateToTokens(text, 10_000)).toBe(text);
    const cut = truncateToTokens(text, 60);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(60);
    const lines = cut.split("\n");
    const marker = lines.pop()!;
    expect(marker).toMatch(/^\[… truncated \d+ more lines\]$/);
    expect(Number(/(\d+)/.exec(marker)![1])).toBe(50 - lines.length);
    // Every kept line is a whole original line, in order.
    expect(lines).toEqual(text.split("\n").slice(0, lines.length));
    expect(lines.length).toBeGreaterThan(0);
    // A single overlong line is cut mid-way only when nothing else fits.
    const one = truncateToTokens("y".repeat(1_000), 20);
    expect(one).toMatch(/^y+\n\[… truncated 1 more line\]$/);
    expect(estimateTokens(one)).toBeLessThanOrEqual(20);
    // A budget too small for any line still says the text was cut.
    expect(truncateToTokens("y".repeat(1_000), 2)).toBe("[… trunc");
    expect(truncateToTokens("y".repeat(1_000), 4)).toBe("[… truncated]");
    expect(truncateToTokens("y".repeat(1_000), 0)).toBe("");

    const items = [
      { id: "a", size: 40 },
      { id: "b", size: 70 },
      { id: "c", size: 30 },
      { id: "d", size: 31 },
    ];
    const fit = fitItemsToBudget(items, 100, (i) => i.size);
    expect(fit.kept.map((i) => i.id)).toEqual(["a", "c"]);
    expect(fit.dropped.map((i) => i.id)).toEqual(["b", "d"]);
    expect(fit.used).toBe(70);
    expect(fitItemsToBudget([], 10, () => 1)).toEqual({ kept: [], dropped: [], used: 0 });
  });
});

describe("cache scoping and retention", () => {
  test("R6.16 response cache entries are per org and purgeable, and answers cut off at the output limit are not cached", async () => {
    const db = await createTestDb();
    const cache = new PostgresResponseCache(db, { ttlHours: 1 });
    let n = 0;
    const fake = new FakeLlm(() => `answer ${++n}`);
    const g = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: fake, cache });
    const ask = (orgId: string, extra: { maxTokens?: number } = {}) =>
      g.text({ system: "Summarize.", prompt: "diff", task: "summary", cache: true, meta: { orgId }, ...extra });

    expect(await ask("org_a")).toMatchObject({ cached: false, text: "answer 1" });
    expect(await ask("org_a")).toMatchObject({ cached: true, text: "answer 1" });
    // Another org never gets org_a's answer.
    expect(await ask("org_b")).toMatchObject({ cached: false, text: "answer 2" });
    // A different output limit is a different entry.
    expect(await ask("org_a", { maxTokens: 100 })).toMatchObject({ cached: false, text: "answer 3" });
    const rows = await db.select().from(llmResponseCache);
    expect(rows.map((r) => r.orgId).sort()).toEqual(["org_a", "org_a", "org_b"]);

    expect(await cache.purgeOrg("org_a")).toBe(2);
    expect((await db.select().from(llmResponseCache)).map((r) => r.orgId)).toEqual(["org_b"]);
    expect(await ask("org_a")).toMatchObject({ cached: false, text: "answer 4" });

    // A truncated answer is returned but never stored.
    const cut: LlmProvider = {
      name: "cut",
      model: "fake-model",
      json: () => Promise.reject(new Error("unused")),
      text: async () => ({ text: "partial", usage: { inputTokens: 1, outputTokens: 100 }, truncated: true }),
    };
    const g2 = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: cut, cache });
    const long = { system: "Explain.", prompt: "everything", task: "chat" as const, cache: true, meta: { orgId: "org_c" } };
    expect(await g2.text(long)).toMatchObject({ text: "partial", cached: false });
    expect(await g2.text(long)).toMatchObject({ cached: false });
    expect(await db.select().from(llmResponseCache).where(eq(llmResponseCache.orgId, "org_c"))).toHaveLength(0);

    // Providers flag answers that hit the output limit.
    const maxed: AnthropicMessagesApi = {
      create: async () => anthropicMessage({ text: "cut off", stopReason: "max_tokens" }),
      parse: async () => Promise.reject(new Error("unused")),
    };
    expect(await new AnthropicProvider({ messages: maxed }).text({ system: "s", prompt: "p" })).toMatchObject({ text: "cut off", truncated: true });
    const length = fakeFetch(() => {
      const body = chatCompletion("cut off");
      body.choices[0]!.finish_reason = "length";
      return jsonResponse(body);
    });
    const openai = new OpenAiCompatibleProvider({ flavor: "openai-compatible", baseURL: "http://localhost:8000/v1", model: "m", fetch: length.fetch });
    expect(await openai.text({ system: "s", prompt: "p" })).toMatchObject({ text: "cut off", truncated: true });
  });

  test("R6.16 embedding cache rows expire after EMBEDDING_CACHE_TTL_DAYS: they are re-embedded, refreshed, and pruned", async () => {
    const db = await createTestDb();
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const inner = new CountingEmbeddings(64);
    const cached = new CachedEmbeddings(inner, { db, ttlDays: 1, now: () => clock, pruneIntervalMs: 0 });

    await cached.embed(["alpha", "beta"]);
    clock += 12 * HOUR;
    await cached.embed(["alpha"]);
    expect(inner.batches).toHaveLength(1);

    clock += 13 * HOUR;
    await cached.embed(["alpha"]);
    // Past the TTL "alpha" is a miss: embedded again and its row refreshed; expired "beta" is pruned.
    expect(inner.batches).toEqual([["alpha", "beta"], ["alpha"]]);
    const rows = await db.select().from(embeddingCache);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contentHash).toBe(contentHash("alpha"));
    expect(rows[0]!.createdAt.getTime()).toBe(clock);

    clock += 2 * HOUR;
    await cached.embed(["alpha"]);
    expect(inner.batches).toHaveLength(2);
    clock += 30 * HOUR;
    expect(await cached.prune()).toBe(1);
    expect(await db.select().from(embeddingCache)).toHaveLength(0);
  });
});
