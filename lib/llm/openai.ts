import { z } from "zod";
import { estimateTokens } from "./budget";
import { httpError } from "./retry";
import {
  LlmAbortError,
  LlmError,
  LlmRefusalError,
  LlmValidationError,
  type EmbeddingProvider,
  type EmbedOptions,
  type JsonRequest,
  type JsonResult,
  type LlmProvider,
  type TextRequest,
  type TextResult,
  type Usage,
} from "./types";

/**
 * OpenAI-style chat endpoints (R6.15): the official OpenAI API, OpenRouter, and any OpenAI-compatible server
 * (vLLM, Ollama, LM Studio, TGI). Structured output asks for `json_schema`; when the endpoint rejects that it falls
 * back to `json_object`, then to the schema embedded in the prompt. Output is always zod-validated.
 */

export type OpenAiFlavor = "openai" | "openrouter" | "openai-compatible";
export type JsonMode = "json_schema" | "json_object" | "prompt";

const NEXT_MODE: Record<Exclude<JsonMode, "prompt">, JsonMode> = { json_schema: "json_object", json_object: "prompt" };

interface HttpConfig {
  baseURL: string;
  apiKey?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

async function post(cfg: HttpConfig, path: string, body: unknown, signal: AbortSignal | undefined, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(`${cfg.baseURL.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...cfg.headers,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) throw new LlmAbortError(`${what} aborted`, { cause: err });
    throw new LlmError(`${what} network error: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, cause: err });
  }
  if (!res.ok) throw httpError(what, res.status, await res.text().catch(() => ""), res.headers);
  try {
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw new LlmAbortError(`${what} aborted`, { cause: err });
    throw new LlmError(`${what} returned a body that is not JSON`, { retryable: true, cause: err });
  }
}

const chatResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nonnegative().nullish() }).nullish(),
    })
    .nullish(),
});

/** OpenAI counts cached prompt tokens inside `prompt_tokens`; we report them separately, like Anthropic. */
function chatUsage(u: z.infer<typeof chatResponseSchema>["usage"]): Usage {
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  const cached = Math.min(u.prompt_tokens_details?.cached_tokens ?? 0, u.prompt_tokens);
  return { inputTokens: u.prompt_tokens - cached, outputTokens: u.completion_tokens, cacheReadTokens: cached };
}

/** Parses model output as JSON, tolerating code fences and surrounding prose. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  let lastError: unknown;
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("not JSON");
}

function schemaInstructions(schemaName: string, jsonSchema: unknown): string {
  return [
    `Respond with only a JSON object (no prose, no code fences) that conforms to the "${schemaName}" JSON Schema below.`,
    "<json_schema>",
    JSON.stringify(jsonSchema),
    "</json_schema>",
  ].join("\n");
}

function isFormatRejection(err: unknown): boolean {
  return (
    err instanceof LlmError &&
    err.status !== undefined &&
    err.status >= 400 &&
    err.status < 500 &&
    !err.retryable &&
    /response_format|json_schema|json_object|structured output/i.test(err.message)
  );
}

export interface OpenAiProviderOptions {
  flavor?: OpenAiFlavor;
  baseURL: string;
  apiKey?: string;
  /** Default model when a request names none. */
  model?: string;
  /** Sent to OpenRouter as `HTTP-Referer` (app attribution). */
  appUrl?: string;
  fetch?: typeof fetch;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: OpenAiFlavor;
  readonly model: string;
  private readonly http: HttpConfig;
  /** Structured-output mode each model is known to accept (learned from rejections). */
  private readonly jsonModes = new Map<string, JsonMode>();

  constructor(private readonly cfg: OpenAiProviderOptions) {
    this.name = cfg.flavor ?? "openai-compatible";
    this.model = cfg.model ?? "";
    this.http = {
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      fetch: cfg.fetch,
      headers:
        this.name === "openrouter" ? { ...(cfg.appUrl ? { "HTTP-Referer": cfg.appUrl } : {}), "X-Title": "OpenReview" } : undefined,
    };
  }

  /** The structured-output mode the next JSON call to `model` will use. */
  jsonModeFor(model: string): JsonMode {
    return this.jsonModes.get(model) ?? "json_schema";
  }

  private modelFor(req: { model?: string }): string {
    const model = req.model ?? this.model;
    if (!model) throw new LlmError(`no model configured for the ${this.name} provider; set LLM_MODEL`);
    return model;
  }

  private async chat(model: string, system: string, prompt: string, maxTokens: number, extra: object, signal?: AbortSignal) {
    const body = {
      model,
      // The official API takes max_completion_tokens (required by its reasoning models); other servers take max_tokens.
      ...(this.name === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      ...extra,
    };
    const raw = await post(this.http, "/chat/completions", body, signal, `${this.name} chat completion`);
    const parsed = chatResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmError(`${this.name} returned an unexpected response: ${z.prettifyError(parsed.error).slice(0, 500)}`, {
        retryable: true,
      });
    }
    const usage = chatUsage(parsed.data.usage);
    const choice = parsed.data.choices[0]!;
    if (choice.message.refusal) throw new LlmRefusalError(`model refused: ${choice.message.refusal}`, { usage });
    if (choice.finish_reason === "content_filter") throw new LlmRefusalError("model output was blocked by a content filter", { usage });
    const servedModel = parsed.data.model && parsed.data.model !== model ? { servedModel: parsed.data.model } : {};
    return { content: choice.message.content ?? "", usage, finishReason: choice.finish_reason ?? null, ...servedModel };
  }

  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const model = this.modelFor(req);
    const jsonSchema = z.toJSONSchema(req.schema, { io: "input", unrepresentable: "any" });
    let mode = this.jsonModeFor(model);
    for (;;) {
      const system = mode === "json_schema" ? req.system : `${req.system}\n\n${schemaInstructions(req.schemaName, jsonSchema)}`;
      const extra =
        mode === "json_schema"
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: req.schemaName.replace(/[^\w-]/g, "_").slice(0, 64), schema: jsonSchema, strict: false },
              },
            }
          : mode === "json_object"
            ? { response_format: { type: "json_object" } }
            : {};
      let res: Awaited<ReturnType<OpenAiCompatibleProvider["chat"]>>;
      try {
        res = await this.chat(model, system, req.prompt, req.maxTokens ?? 16_000, extra, req.signal);
      } catch (err) {
        if (mode !== "prompt" && isFormatRejection(err)) {
          mode = NEXT_MODE[mode];
          this.jsonModes.set(model, mode);
          continue;
        }
        throw err;
      }
      const { content, usage, finishReason } = res;
      let value: unknown;
      try {
        value = extractJson(content);
      } catch (err) {
        throw new LlmValidationError(
          `invalid JSON for ${req.schemaName} (finish: ${finishReason})`,
          err instanceof Error ? err.message : String(err),
          { usage },
        );
      }
      const result = req.schema.safeParse(value);
      if (!result.success) {
        throw new LlmValidationError(`output does not match ${req.schemaName}`, z.prettifyError(result.error), { usage });
      }
      return { data: result.data, usage, ...(res.servedModel ? { servedModel: res.servedModel } : {}) };
    }
  }

  async text(req: TextRequest): Promise<TextResult> {
    const model = this.modelFor(req);
    const res = await this.chat(model, req.system, req.prompt, req.maxTokens ?? 16_000, {}, req.signal);
    if (!res.content) throw new LlmError(`empty completion (finish: ${res.finishReason})`, { usage: res.usage });
    return { text: res.content, usage: res.usage, ...(res.servedModel ? { servedModel: res.servedModel } : {}) };
  }
}

const embeddingResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.number().nonnegative() }).nullish(),
});

export interface OpenAiEmbeddingsOptions {
  flavor?: "openai" | "openai-compatible";
  baseURL: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  /** Texts per request (default 64). */
  batchSize?: number;
}

/** Embeddings from the OpenAI API or any OpenAI-compatible `/embeddings` endpoint. */
export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  readonly name: "openai" | "openai-compatible";
  readonly model: string;
  private readonly http: HttpConfig;
  private readonly batchSize: number;

  constructor(cfg: OpenAiEmbeddingsOptions) {
    this.name = cfg.flavor ?? "openai-compatible";
    this.model = cfg.model;
    this.http = { baseURL: cfg.baseURL, apiKey: cfg.apiKey, fetch: cfg.fetch };
    this.batchSize = cfg.batchSize ?? 64;
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    return (await this.embedWithUsage(texts, opts)).vectors;
  }

  async embedWithUsage(texts: string[], opts: EmbedOptions = {}): Promise<{ vectors: number[][]; usage: Usage }> {
    const vectors: number[][] = [];
    let inputTokens = 0;
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const raw = await post(this.http, "/embeddings", { model: this.model, input: batch }, opts.signal, `${this.name} embeddings`);
      const parsed = embeddingResponseSchema.safeParse(raw);
      if (!parsed.success || parsed.data.data.length !== batch.length) {
        throw new LlmError(`${this.name} embeddings returned an unexpected response`, { retryable: true });
      }
      vectors.push(...[...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
      // Servers that omit usage are charged by estimate so the call is never recorded as free.
      inputTokens += parsed.data.usage?.prompt_tokens ?? batch.reduce((n, t) => n + estimateTokens(t), 0);
    }
    return { vectors, usage: { inputTokens, outputTokens: 0 } };
  }
}
