import { env } from "@/lib/env";
import { EMBEDDING_DIM } from "@/lib/db/schema";
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
import { FakeEmbeddings, FakeLlm } from "./fake";
import { OpenAiCompatibleEmbeddings, OpenAiCompatibleProvider } from "./openai";
import { LlmError, type EmbeddingProvider, type LlmProvider } from "./types";

export * from "./types";

/**
 * Fits a provider vector into the fixed pgvector column. Shorter vectors are
 * zero-padded, which leaves cosine similarity unchanged; longer ones are rejected.
 */
export function toStoredEmbedding(v: number[]): number[] {
  if (v.length > EMBEDDING_DIM) {
    throw new LlmError(`embedding has ${v.length} dimensions; at most ${EMBEDDING_DIM} are supported`);
  }
  return v.length === EMBEDDING_DIM ? v : [...v, ...new Array<number>(EMBEDDING_DIM - v.length).fill(0)];
}

export interface LlmOverrides {
  provider?: "anthropic" | "openai";
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

/** The configured chat model. `overrides` lets an org bring its own endpoint (R4.6). */
export function llm(overrides: LlmOverrides = {}): LlmProvider {
  const e = env();
  const provider = overrides.provider ?? e.LLM_PROVIDER;
  const model = overrides.model ?? e.LLM_MODEL;
  const baseURL = overrides.baseURL ?? e.LLM_BASE_URL;
  const apiKey = overrides.apiKey ?? e.LLM_API_KEY;
  if (provider === "fake") return new FakeLlm();
  if (provider === "openai") {
    if (!baseURL || !model) throw new LlmError("LLM_BASE_URL and LLM_MODEL are required for the openai provider");
    return new OpenAiCompatibleProvider({ baseURL, apiKey, model });
  }
  return new AnthropicProvider(model ?? DEFAULT_ANTHROPIC_MODEL, { apiKey, baseURL });
}

export function embeddings(): EmbeddingProvider {
  const e = env();
  if (e.EMBEDDING_PROVIDER === "fake") return new FakeEmbeddings();
  return new OpenAiCompatibleEmbeddings({
    baseURL: e.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: e.EMBEDDING_API_KEY,
    model: e.EMBEDDING_MODEL ?? "text-embedding-3-small",
  });
}
