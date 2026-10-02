import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { isRetryableStatus, parseRetryAfter } from "./retry";
import { DEFAULT_ANTHROPIC_MODEL } from "./routing";
import {
  LlmAbortError,
  LlmError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmValidationError,
  type Effort,
  type JsonRequest,
  type JsonResult,
  type LlmProvider,
  type TextRequest,
  type TextResult,
  type Usage,
} from "./types";

export { DEFAULT_ANTHROPIC_MODEL };

/** Server-side refusal fallback (`fallbacks: "default"` routes a declined request by refusal category). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicModelCaps {
  /** Accepts `output_config.effort`. */
  effort: boolean;
  /** Accepts the server-side fallback beta + `fallbacks: "default"`. */
  fallbacks: boolean;
}

/**
 * Request-shaping capabilities per model. Models not listed get neither effort nor fallbacks, so an unfamiliar
 * model id still receives a request it accepts (with the API's default effort).
 */
export const ANTHROPIC_MODEL_CAPS: Readonly<Record<string, AnthropicModelCaps>> = {
  "claude-fable-5-1": { effort: true, fallbacks: true },
  "claude-opus-5-5": { effort: true, fallbacks: true },
  "claude-opus-5": { effort: true, fallbacks: true },
  "claude-sonnet-5-5": { effort: true, fallbacks: true },
  "claude-sonnet-5": { effort: true, fallbacks: false },
  "claude-haiku-4-5": { effort: false, fallbacks: false },
};

export function anthropicCaps(model: string): AnthropicModelCaps {
  return ANTHROPIC_MODEL_CAPS[model] ?? { effort: false, fallbacks: false };
}

/** The response fields OpenReview reads; the SDK's `BetaMessage` / `ParsedBetaMessage` satisfy it. */
export interface AnthropicResponse {
  model: string;
  stop_reason: string | null;
  stop_details?: { explanation?: string | null } | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export interface AnthropicRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** The slice of `client.beta.messages` the provider uses; tests inject a fake. */
export interface AnthropicMessagesApi {
  create(body: MessageCreateParamsNonStreaming, options?: AnthropicRequestOptions): PromiseLike<AnthropicResponse>;
  parse(body: MessageCreateParamsNonStreaming, options?: AnthropicRequestOptions): PromiseLike<AnthropicResponse>;
}

export interface AnthropicProviderOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  /** Per-request timeout handed to the SDK (the gateway also enforces it). */
  timeoutMs?: number;
  /** Injected transport; defaults to the official SDK with its own retries disabled (the gateway retries). */
  messages?: AnthropicMessagesApi;
}

/** Builds the Messages API body for `model`, sending effort and fallbacks only where the model accepts them. */
export function anthropicRequest(
  model: string,
  req: { system: string; prompt: string; maxTokens?: number; effort?: Effort },
  defaultEffort: Effort,
  format?: NonNullable<MessageCreateParamsNonStreaming["output_config"]>["format"],
): MessageCreateParamsNonStreaming {
  const caps = anthropicCaps(model);
  const outputConfig: NonNullable<MessageCreateParamsNonStreaming["output_config"]> = {};
  if (caps.effort) outputConfig.effort = req.effort ?? defaultEffort;
  if (format) outputConfig.format = format;
  return {
    model,
    max_tokens: req.maxTokens ?? 16_000,
    ...(caps.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: req.prompt }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
}

export function anthropicUsage(u: AnthropicResponse["usage"]): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Maps SDK errors onto LlmError with retry classification and `retry-after`. */
export function fromAnthropicError(err: unknown): unknown {
  if (err instanceof LlmError) return err;
  if (err instanceof APIUserAbortError) return new LlmAbortError("Anthropic request aborted", { cause: err });
  if (err instanceof APIConnectionTimeoutError) return new LlmTimeoutError("Anthropic request timed out", { cause: err });
  if (err instanceof APIConnectionError) {
    return new LlmError(`Anthropic connection error: ${err.message}`, { retryable: true, cause: err });
  }
  if (err instanceof APIError && typeof err.status === "number") {
    return new LlmError(`Anthropic API error: ${err.message}`, {
      status: err.status,
      retryable: isRetryableStatus(err.status),
      retryAfterMs: parseRetryAfter(err.headers),
      cause: err,
    });
  }
  if (err instanceof AnthropicError) return new LlmError(`Anthropic SDK error: ${err.message}`, { cause: err });
  return err;
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Claude via the official SDK. Structured output uses `client.beta.messages.parse` with `betaZodOutputFormat`;
 * models that accept it get `output_config.effort` and the server-side refusal fallback chain, and a refusal from
 * the whole chain surfaces as LlmRefusalError. Usage includes prompt-cache reads and writes.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly messages: AnthropicMessagesApi;
  private readonly timeoutMs?: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.timeoutMs = opts.timeoutMs;
    this.messages =
      opts.messages ??
      new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0, timeout: opts.timeoutMs }).beta.messages;
  }

  private options(signal?: AbortSignal): AnthropicRequestOptions {
    return { ...(signal ? { signal } : {}), ...(this.timeoutMs ? { timeout: this.timeoutMs } : {}) };
  }

  private served(res: AnthropicResponse, model: string): { servedModel?: string } {
    return res.model && res.model !== model ? { servedModel: res.model } : {};
  }

  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const model = req.model ?? this.model;
    let format: ReturnType<typeof betaZodOutputFormat<z.ZodType<T>>>;
    try {
      format = betaZodOutputFormat(req.schema);
    } catch (err) {
      throw new LlmError(`cannot express ${req.schemaName} as a JSON schema: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    let outcome: ParseOutcome<T> | undefined;
    // Validation failures come back as a value (not an SDK throw) so the attempt's usage is still recorded.
    const safeFormat = {
      ...format,
      parse: (content: string): ParseOutcome<T> | undefined => {
        let result: ParseOutcome<T>;
        try {
          result = { ok: true, value: format.parse(content) };
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        outcome ??= result;
        return result;
      },
    };
    let res: AnthropicResponse;
    try {
      res = await this.messages.parse(anthropicRequest(model, req, "high", safeFormat), this.options(req.signal));
    } catch (err) {
      throw fromAnthropicError(err);
    }
    const usage = anthropicUsage(res.usage);
    if (res.stop_reason === "refusal") {
      throw new LlmRefusalError(res.stop_details?.explanation || "model refused", { usage });
    }
    if (!outcome) {
      throw new LlmValidationError(
        `no ${req.schemaName} output (stop: ${res.stop_reason})`,
        "the response contained no JSON output",
        { usage },
      );
    }
    if (!outcome.ok) {
      throw new LlmValidationError(`output does not match ${req.schemaName} (stop: ${res.stop_reason})`, outcome.error, { usage });
    }
    return { data: outcome.value, usage, ...this.served(res, model) };
  }

  async text(req: TextRequest): Promise<TextResult> {
    const model = req.model ?? this.model;
    let res: AnthropicResponse;
    try {
      res = await this.messages.create(anthropicRequest(model, req, "medium"), this.options(req.signal));
    } catch (err) {
      throw fromAnthropicError(err);
    }
    const usage = anthropicUsage(res.usage);
    if (res.stop_reason === "refusal") {
      throw new LlmRefusalError(res.stop_details?.explanation || "model refused", { usage });
    }
    const text = res.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("");
    return { text, usage, ...this.served(res, model) };
  }
}
