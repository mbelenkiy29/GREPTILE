export type InferenceQuote = {
  provider: string; model: string; baseUrl: string;
  inputTokenCeiling: number; outputTokenCeiling: number;
};
export type InferenceReceipt = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
export type InferenceBilling = {
  reserve(quote: InferenceQuote): Promise<string | null>;
  settle(id: string, usage: InferenceReceipt): Promise<void>;
};
export class InferenceBudgetError extends Error {}

// USD per million tokens (= micro-dollars per token). cacheRead/cacheWrite default to the input price.
export type InferencePrice = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
type PriceEntry = InferencePrice & { above?: { inputTokens: number } & InferencePrice };
export const officialEndpoints: Record<string, string> = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1" };

// Standard published prices, checked 2026-10-14 against platform.claude.com/docs/en/about-claude/pricing and
// developers.openai.com/api/docs/pricing. Built-in entries apply only to the official endpoint; tiered models
// carry their long-prompt tier so reservations never under-price a large request.
export const builtInPrices: Record<string, PriceEntry> = {
  "openai:gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "openai:gpt-4.1-2025-04-14": { input: 2, output: 8, cacheRead: 0.5 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "openai:gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "openai:gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "openai:gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125 },
  "openai:gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175 },
  "openai:gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "openai:gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02 },
  "openai:o3": { input: 2, output: 8, cacheRead: 0.5 },
  "openai:o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "openai:text-embedding-3-small": { input: 0.02, output: 0 },
  "openai:text-embedding-3-large": { input: 0.13, output: 0 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "anthropic:claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, above: { inputTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  "anthropic:claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic:claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "anthropic:claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic:claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "anthropic:claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "anthropic:claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const priceNumber = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10_000;
// INFERENCE_PRICES is an explicit operator price table: {"provider:model":{"input":1,"output":2,"cacheRead":0.1,"cacheWrite":1.25,"baseUrl":"https://…"}}.
// Unlike the display-only LLM_*_COST_PER_MILLION estimates it governs budget enforcement, so malformed entries are rejected.
export function priceOverrides(raw = process.env.INFERENCE_PRICES): Record<string, PriceEntry & { baseUrl?: string }> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("INFERENCE_PRICES must be a JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INFERENCE_PRICES must be a JSON object");
  const out: Record<string, PriceEntry & { baseUrl?: string }> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    if (!/^[a-z]+:[^\s]{1,200}$/.test(key) || !value || typeof value !== "object" || !priceNumber(value.input) || !priceNumber(value.output) || [value.cacheRead, value.cacheWrite].some(n => n !== undefined && !priceNumber(n)) || (value.baseUrl !== undefined && typeof value.baseUrl !== "string")) throw new Error("Invalid INFERENCE_PRICES entry " + key.slice(0, 80));
    out[key] = { input: value.input as number, output: value.output as number, ...(value.cacheRead !== undefined ? { cacheRead: value.cacheRead as number } : {}), ...(value.cacheWrite !== undefined ? { cacheWrite: value.cacheWrite as number } : {}), ...(value.baseUrl ? { baseUrl: (value.baseUrl as string).replace(/\/$/, "") } : {}) };
  }
  return out;
}

// Price lookup for display estimates; returns undefined instead of throwing.
export function knownPrice(provider: string, model: string, baseUrl: string, inputTokens = 0): InferencePrice | undefined {
  const key = provider + ":" + model, base = baseUrl.replace(/\/$/, "");
  let overrides: ReturnType<typeof priceOverrides> = {};
  try { overrides = priceOverrides(); } catch { return undefined; }
  const override = overrides[key];
  if (override && (!override.baseUrl || override.baseUrl === base)) return override;
  const entry = officialEndpoints[provider] === base ? builtInPrices[key] : undefined;
  if (!entry) return undefined;
  return entry.above && inputTokens > entry.above.inputTokens ? entry.above : { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite };
}

// Budget pricing: unknown providers/models/endpoints fail closed when a deployment budget is active.
export function inferencePrice(quote: InferenceQuote): InferencePrice {
  const price = knownPrice(quote.provider, quote.model, quote.baseUrl, quote.inputTokenCeiling);
  if (!price) {
    priceOverrides(); // surface malformed operator tables instead of a generic message
    throw new Error(officialEndpoints[quote.provider] && officialEndpoints[quote.provider] === quote.baseUrl.replace(/\/$/, "") ? "Inference budget has no verified price for this model" : "Inference budget has no verified price for this endpoint");
  }
  return price;
}
// Reservation ceiling: every input token may be a (premium) cache write.
export function reservationMicros(input: number, output: number, price: InferencePrice) {
  return inferenceMicros(input, output, { ...price, input: Math.max(price.input, price.cacheWrite ?? price.input) });
}
export function inferenceMicros(input: number, output: number, price: InferencePrice, cache: { read?: number; write?: number } = {}) {
  const read = cache.read ?? 0, write = cache.write ?? 0;
  if (![input, output, read, write].every(n => Number.isSafeInteger(n) && n >= 0) || read + write > input) throw new Error("Invalid inference token receipt");
  const amount = Math.ceil((input - read - write) * price.input + read * (price.cacheRead ?? price.input) + write * (price.cacheWrite ?? price.input) + output * price.output);
  if (!Number.isSafeInteger(amount)) throw new Error("Inference amount exceeds accounting limits");
  return amount;
}
