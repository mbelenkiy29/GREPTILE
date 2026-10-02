import { llmEnvSchema } from "@/lib/env";
import type { Db } from "@/lib/db";
import { PostgresResponseCache } from "./cache";
import { CachedEmbeddings } from "./embedding-cache";
import { FakeEmbeddings } from "./fake";
import { createGateway, type ModelGateway } from "./gateway";
import { OpenAiCompatibleEmbeddings } from "./openai";
import { pricingTable } from "./pricing";
import { PostgresModelCallRecorder } from "./recorder";
import { embeddingRoute, type OrgLlmOverride } from "./routing";
import { LlmError, type EmbeddingProvider } from "./types";

export * from "./types";
export { toStoredEmbedding } from "./vector";
export { createGateway, ModelGateway, type GatewayJsonResult, type GatewayOptions, type GatewayTextResult } from "./gateway";
export { routeFor, resolveRoute, embeddingRoute, ANTHROPIC_ROUTES, DEFAULT_ANTHROPIC_MODEL, type OrgLlmOverride } from "./routing";
export { estimateCost, pricingTable, BUILTIN_PRICING, type ModelPrice, type PricingTable } from "./pricing";
export { estimateTokens, truncateToTokens, fitItemsToBudget } from "./budget";
export {
  InMemoryModelCallRecorder,
  PostgresModelCallRecorder,
  modelCallTotals,
  type ModelCallRecord,
  type ModelCallRecorder,
  type ModelCallStatus,
  type ModelCallTotals,
} from "./recorder";
export { PostgresResponseCache, responseCacheKey, type ResponseCache } from "./cache";
export { CachedEmbeddings } from "./embedding-cache";

/**
 * The env-configured model gateway (R6.15). With `db`, every call is recorded in `model_calls` and calls that pass
 * `cache: true` use the Postgres response cache. `orgOverride` applies an org's bring-your-own LLM settings.
 */
export function llm(opts: { db?: Db; orgOverride?: OrgLlmOverride } = {}): ModelGateway {
  const e = llmEnvSchema.parse(process.env);
  return createGateway({
    env: e,
    orgOverride: opts.orgOverride,
    recorder: opts.db ? new PostgresModelCallRecorder(opts.db) : undefined,
    cache: opts.db ? new PostgresResponseCache(opts.db, { ttlHours: e.LLM_CACHE_TTL_HOURS }) : undefined,
  });
}

/** The env-configured embedding model; with `db`, wrapped in the embedding cache and recorded (R6.16). */
export function embeddings(opts: { db?: Db } = {}): EmbeddingProvider {
  const e = llmEnvSchema.parse(process.env);
  const route = embeddingRoute(e);
  let inner: EmbeddingProvider;
  if (route.provider === "fake") {
    inner = new FakeEmbeddings();
  } else {
    if (!route.baseURL) throw new LlmError(`no base URL for the ${route.provider} embedding provider`);
    inner = new OpenAiCompatibleEmbeddings({
      flavor: route.provider === "openai" ? "openai" : "openai-compatible",
      baseURL: route.baseURL,
      apiKey: e.EMBEDDING_API_KEY,
      model: route.model,
    });
  }
  if (!opts.db) return inner;
  return new CachedEmbeddings(inner, {
    db: opts.db,
    recorder: new PostgresModelCallRecorder(opts.db),
    pricing: pricingTable(e.LLM_PRICING_JSON),
    maxRetries: e.LLM_MAX_RETRIES,
    timeoutMs: e.LLM_TIMEOUT_MS,
  });
}
