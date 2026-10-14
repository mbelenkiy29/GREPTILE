import { z } from "zod";
import { validateModelUrl } from "./model";
import type { InferenceBilling } from "../inference-billing";
export class Embeddings {
  constructor(private billing?: InferenceBilling) {}
  readonly model = process.env.EMBEDDING_MODEL;
  async embed(
    inputs: string[],
  ): Promise<{ vectors: number[][]; tokens: number; estimatedCost: number }> {
    if (!this.model)
      throw new Error("Configure EMBEDDING_MODEL to enable semantic retrieval");
    const base = validateModelUrl(
      process.env.EMBEDDING_BASE_URL ||
        process.env.LLM_BASE_URL ||
        "https://api.openai.com/v1",
      process.env.LLM_ALLOW_LOCAL === "true",
    );
    const input = inputs.map(i => i.slice(0, 8000));
    const reservation = await this.billing?.reserve({ provider: "openai", model: this.model, baseUrl: base.toString().replace(/\/$/, ""), inputTokenCeiling: input.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8") + 1024, 0), outputTokenCeiling: 0 });
    const response = await fetch(
      base.toString().replace(/\/$/, "") + "/embeddings",
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY || ""}`,
        },
        body: JSON.stringify({
          model: this.model,
          input,
          dimensions: 1536,
        }),
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok)
      throw new Error(`Embedding provider HTTP ${response.status}`);
    const raw = await response.json();
    if (reservation && Number.isSafeInteger(raw.usage?.total_tokens)) {
      try { await this.billing!.settle(reservation, { inputTokens: raw.usage.total_tokens, outputTokens: 0 }); }
      catch { console.error(JSON.stringify({ event: "embedding.billing_receipt_unavailable" })); }
    }
    const result = z
      .object({
        data: z.array(
          z.object({
            index: z.number().int().nonnegative(),
            embedding: z.array(z.number().finite()).length(1536),
          }),
        ),
        usage: z.object({ total_tokens: z.number().nonnegative() }).optional(),
      })
      .parse(raw);
    if (
      result.data.length !== inputs.length ||
      new Set(result.data.map((d) => d.index)).size !== inputs.length ||
      result.data.some((d) => d.index >= inputs.length)
    )
      throw new Error("Embedding response index mismatch");
    const tokens =
      result.usage?.total_tokens ?? Math.ceil(inputs.join("").length / 4);
    return {
      vectors: result.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding),
      tokens,
      estimatedCost:
        (tokens * Number(process.env.EMBEDDING_COST_PER_MILLION ?? 0)) /
        1000000,
    };
  }
}
