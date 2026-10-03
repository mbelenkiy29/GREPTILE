import { z } from "zod";
import { LlmError, type Usage } from "./types";

/**
 * Model prices in USD per million tokens (R6.15, R6.16). Anthropic first-party rates (cache write = 5-minute TTL)
 * and OpenAI embedding rates. `LLM_PRICING_JSON` adds or replaces entries, e.g. for self-hosted or OpenRouter models.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

export const BUILTIN_PRICING: PricingTable = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "text-embedding-3-small": { input: 0.02, output: 0, cacheRead: 0.02, cacheWrite: 0.02 },
  "text-embedding-3-large": { input: 0.13, output: 0, cacheRead: 0.13, cacheWrite: 0.13 },
};

const price = z.number().finite().nonnegative();

/** `LLM_PRICING_JSON` entries. Missing cache prices default to the input price (never under-estimates). */
const overrideSchema = z.record(
  z.string().min(1),
  z.strictObject({ input: price, output: price.default(0), cacheRead: price.optional(), cacheWrite: price.optional() }),
);

/** The built-in table with `LLM_PRICING_JSON` merged over it. Throws a readable LlmError on invalid JSON. */
export function pricingTable(json?: string): PricingTable {
  if (!json) return BUILTIN_PRICING;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new LlmError("LLM_PRICING_JSON is not valid JSON");
  }
  const parsed = overrideSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LlmError(`LLM_PRICING_JSON is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const table: Record<string, ModelPrice> = { ...BUILTIN_PRICING };
  for (const [model, p] of Object.entries(parsed.data)) {
    table[model] = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input, cacheWrite: p.cacheWrite ?? p.input };
  }
  return table;
}

/**
 * Estimated USD cost of `usage` on `model`, rounded to the `model_calls.cost_usd` precision (6 decimals).
 * Returns null for a model without a price, so unknown cost is recorded as unknown rather than 0.
 */
export function estimateCost(model: string, usage: Usage, table: PricingTable = BUILTIN_PRICING): number | null {
  const p = table[model];
  if (!p) return null;
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cacheReadTokens ?? 0) * p.cacheRead +
      (usage.cacheWriteTokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
