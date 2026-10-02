import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LlmError, LlmRefusalError, type JsonRequest, type LlmProvider, type TextRequest } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Claude via the official SDK. Uses the server-side refusal fallback chain
 * (`fallbacks: "default"`) so a safety decline is retried on a fallback model
 * inside the same call; a refusal from the whole chain surfaces as LlmRefusalError.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    opts: { apiKey?: string; baseURL?: string } = {},
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async json<T>(req: JsonRequest<T>) {
    const res = await this.client.beta.messages.parse({
      model: req.model ?? this.model,
      max_tokens: req.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: req.effort ?? "high", format: betaZodOutputFormat(req.schema) },
    });
    if (res.stop_reason === "refusal") throw new LlmRefusalError(res.stop_details?.explanation ?? "model refused");
    if (res.parsed_output == null) throw new LlmError(`no parseable ${req.schemaName} output (stop: ${res.stop_reason})`);
    return {
      data: res.parsed_output as T,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }

  async text(req: TextRequest) {
    const res = await this.client.beta.messages.create({
      model: req.model ?? this.model,
      max_tokens: req.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: req.effort ?? "medium" },
    });
    if (res.stop_reason === "refusal") throw new LlmRefusalError(res.stop_details?.explanation ?? "model refused");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
  }
}
