import type { z } from "zod";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface JsonRequest<T> {
  /** Stable instructions; providers may cache this prefix. */
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Short name of the output shape, used as the JSON schema name. */
  schemaName: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Overrides the provider's default model for this call (e.g. a review tier's model). */
  model?: string;
}

export interface TextRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: JsonRequest<unknown>["effort"];
  model?: string;
}

/** Every LLM call in OpenReview goes through this interface (H4). */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  json<T>(req: JsonRequest<T>): Promise<{ data: T; usage: Usage }>;
  text(req: TextRequest): Promise<{ text: string; usage: Usage }>;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class LlmError extends Error {}

/** The model declined (e.g. a safety refusal); callers should skip rather than retry. */
export class LlmRefusalError extends LlmError {}

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
