/**
 * Local mode's model and embeddings (R3.5), configured from the environment exactly like the server (LLM_PROVIDER,
 * LLM_API_KEY, LLM_MODEL, …) and run through the same model gateway. `ANTHROPIC_API_KEY` works as the key of the
 * default anthropic provider.
 */
import type { Db } from "@/lib/db";
import { CachedEmbeddings } from "@/lib/llm/embedding-cache";
import { createGateway, type ModelGateway } from "@/lib/llm/gateway";
import { OpenAiCompatibleEmbeddings } from "@/lib/llm/openai";
import { pricingTable } from "@/lib/llm/pricing";
import { PostgresModelCallRecorder } from "@/lib/llm/recorder";
import { embeddingRoute } from "@/lib/llm/routing";
import type { EmbeddingProvider } from "@/lib/llm/types";
import { llmEnvSchema } from "@/lib/env";
import { CliError } from "../errors";

export const NO_MODEL_HINT = "Set ANTHROPIC_API_KEY (or LLM_PROVIDER and LLM_API_KEY), or run `openreview login` to review on your server.";
export const MODEL_FAILURE_HINT = "Check your model settings (LLM_PROVIDER, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL) and network, or run with --verbose for details.";

/** The LLM variables from `env`, with ANTHROPIC_API_KEY as the anthropic provider's key when LLM_API_KEY is unset. */
export function modelEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(llmEnvSchema.shape)) out[key] = env[key] === "" ? undefined : env[key];
  const provider = out.LLM_PROVIDER ?? "anthropic";
  if (provider === "anthropic" && !out.LLM_API_KEY && env.ANTHROPIC_API_KEY) out.LLM_API_KEY = env.ANTHROPIC_API_KEY;
  return out;
}

/** The gateway local reviews run through; a helpful error when no usable model is configured. */
export function localGateway(env: Record<string, string | undefined>, db?: Db): ModelGateway {
  const e = modelEnv(env);
  if (e.LLM_PROVIDER === "fake") throw new CliError("LLM_PROVIDER=fake is for tests and can't review code.", NO_MODEL_HINT);
  let gateway: ModelGateway;
  try {
    gateway = createGateway({ env: e, ...(db ? { recorder: new PostgresModelCallRecorder(db) } : {}) });
  } catch (err) {
    throw new CliError(`The model configuration is invalid: ${(err as Error).message}`, NO_MODEL_HINT);
  }
  const problem = gateway.configurationError("review");
  if (problem) throw new CliError(`No model is configured for local reviews (${problem}).`, NO_MODEL_HINT);
  return gateway;
}

/**
 * Embeddings for semantic search in the local index, when configured (EMBEDDING_API_KEY, or an openai-compatible
 * EMBEDDING_BASE_URL). Without them, local retrieval uses the code graph and full-text search.
 */
export function localEmbedder(env: Record<string, string | undefined>, db: Db): EmbeddingProvider | undefined {
  const e = llmEnvSchema.parse(modelEnv(env));
  if (e.EMBEDDING_PROVIDER === "fake") return undefined;
  if (e.EMBEDDING_PROVIDER === "openai" && !e.EMBEDDING_API_KEY) return undefined;
  if (e.EMBEDDING_PROVIDER === "openai-compatible" && !e.EMBEDDING_BASE_URL) return undefined;
  const route = embeddingRoute(e);
  const inner = new OpenAiCompatibleEmbeddings({
    flavor: route.provider === "openai" ? "openai" : "openai-compatible",
    baseURL: route.baseURL!,
    apiKey: e.EMBEDDING_API_KEY,
    model: route.model,
  });
  return new CachedEmbeddings(inner, {
    db,
    recorder: new PostgresModelCallRecorder(db),
    pricing: pricingTable(e.LLM_PRICING_JSON),
    maxRetries: e.LLM_MAX_RETRIES,
    timeoutMs: e.LLM_TIMEOUT_MS,
    ttlDays: e.EMBEDDING_CACHE_TTL_DAYS,
  });
}
