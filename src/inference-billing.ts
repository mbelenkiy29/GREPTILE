export type InferenceQuote = {
  provider: string; model: string; baseUrl: string;
  inputTokenCeiling: number; outputTokenCeiling: number;
};
export type InferenceBilling = {
  reserve(quote: InferenceQuote): Promise<string | null>;
  settle(id: string, usage: { inputTokens: number; outputTokens: number }): Promise<void>;
};
export class InferenceBudgetError extends Error {}

// Verified standard OpenAI prices. Unknown providers/models fail closed when a
// deployment budget is active; configured estimated prices cannot override it.
export function inferencePrice(quote: InferenceQuote) {
  if (quote.provider !== "openai" || quote.baseUrl.replace(/\/$/, "") !== "https://api.openai.com/v1") throw new Error("Inference budget has no verified price for this endpoint");
  if (["gpt-4.1", "gpt-4.1-2025-04-14"].includes(quote.model)) return { input: 2, output: 8 };
  if (quote.model === "text-embedding-3-small") return { input: 0.02, output: 0 };
  throw new Error("Inference budget has no verified price for this model");
}
export function inferenceMicros(input: number, output: number, price: { input: number; output: number }) {
  if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid inference token receipt");
  const amount = Math.ceil(input * price.input + output * price.output);
  if (!Number.isSafeInteger(amount)) throw new Error("Inference amount exceeds accounting limits");
  return amount;
}
