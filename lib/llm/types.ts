import type { z } from "zod";

/** What a model call is for; the gateway routes each task to a model (R6.15). */
export const LLM_TASKS = ["classify", "context", "review", "verify", "summary", "chat", "knowledge", "rules", "embed"] as const;
export type LlmTask = (typeof LLM_TASKS)[number];
/** Tasks served by chat models (every task but `embed`). */
export type ChatTask = Exclude<LlmTask, "embed">;

/** Review depth: picks the review / verify model and effort. */
export const REVIEW_MODES = ["fast", "standard", "deep"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const LLM_PROVIDERS = ["anthropic", "openai", "openrouter", "openai-compatible", "fake"] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens?: number;
}

/** Correlation ids recorded with every model call (`model_calls`). */
export interface CallMeta {
  orgId?: string | null;
  repoId?: number | null;
  reviewRunId?: number | null;
  agentRunId?: number | null;
}

interface RequestBase {
  /** Stable instructions; providers may cache this prefix. */
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: Effort;
  /** Overrides the routed model for this call (highest precedence). */
  model?: string;
  /** Selects the model route (R6.15). Calls without a task use the default model. */
  task?: ChatTask;
  mode?: ReviewMode;
  meta?: CallMeta;
  /** Opt in to the response cache (R6.16). Only for deterministic prompts whose answer may be reused. */
  cache?: boolean;
  /** Cancels the call (e.g. a superseded review). Cancellation is never retried. */
  signal?: AbortSignal;
}

export interface JsonRequest<T> extends RequestBase {
  schema: z.ZodType<T>;
  /** Short name of the output shape, used as the JSON schema name. */
  schemaName: string;
}

export type TextRequest = RequestBase;

export interface JsonResult<T> {
  data: T;
  usage: Usage;
  /** The model that produced the answer when it differs from the requested one (server-side fallback). */
  servedModel?: string;
}

export interface TextResult {
  text: string;
  usage: Usage;
  servedModel?: string;
}

/** Every LLM call in OpenReview goes through this interface (H4). */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  json<T>(req: JsonRequest<T>): Promise<JsonResult<T>>;
  text(req: TextRequest): Promise<TextResult>;
}

export interface EmbedOptions {
  meta?: CallMeta;
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  readonly name: string;
  /** Model id; keys the embedding cache and prices embed calls. */
  readonly model?: string;
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
  /** Vectors plus provider-reported usage, when the provider reports it. */
  embedWithUsage?(texts: string[], opts?: EmbedOptions): Promise<{ vectors: number[][]; usage: Usage }>;
}

/** Where a route's model came from, highest precedence first. */
export type RouteSource = "call" | "org" | "task_mode_env" | "task_env" | "default_env" | "builtin";

/** The provider, model, and limits one call runs with; returned with every gateway result. */
export interface ResolvedRoute {
  /** `null` when the caller passed no task. */
  task: LlmTask | null;
  mode: ReviewMode;
  provider: LlmProviderName;
  model: string;
  effort?: Effort;
  maxTokens: number;
  source: RouteSource;
  /** Endpoint of OpenAI-style providers (never carries credentials). */
  baseURL?: string;
}

export interface LlmErrorOptions {
  /** HTTP status of the failed request, when there was one. */
  status?: number;
  /** Whether trying again may succeed (rate limit, overload, network, timeout). */
  retryable?: boolean;
  /** Server-requested wait before retrying (`retry-after`). */
  retryAfterMs?: number;
  /** Tokens the failed attempt consumed (e.g. output that failed validation). */
  usage?: Usage;
  cause?: unknown;
}

export class LlmError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  usage?: Usage;

  constructor(message: string, opts: LlmErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.usage = opts.usage;
  }
}

/** The model declined (e.g. a safety refusal); callers should skip rather than retry. */
export class LlmRefusalError extends LlmError {
  constructor(message: string, opts: Omit<LlmErrorOptions, "retryable"> = {}) {
    super(message, { ...opts, retryable: false });
    this.name = "LlmRefusalError";
  }
}

/** Structured output did not parse or match its schema. The gateway retries once with the validation error. */
export class LlmValidationError extends LlmError {
  constructor(
    message: string,
    readonly issues: string,
    opts: Omit<LlmErrorOptions, "retryable"> = {},
  ) {
    super(message, { ...opts, retryable: false });
    this.name = "LlmValidationError";
  }
}

/** An attempt exceeded `LLM_TIMEOUT_MS`; retried like a transient failure. */
export class LlmTimeoutError extends LlmError {
  constructor(message: string, opts: Omit<LlmErrorOptions, "retryable"> = {}) {
    super(message, { ...opts, retryable: true });
    this.name = "LlmTimeoutError";
  }
}

/** The caller cancelled the call. Never retried. */
export class LlmAbortError extends LlmError {
  constructor(message = "model call cancelled", opts: Omit<LlmErrorOptions, "retryable"> = {}) {
    super(message, { ...opts, retryable: false });
    this.name = "LlmAbortError";
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cacheWrite = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  if (cacheRead) out.cacheReadTokens = cacheRead;
  if (cacheWrite) out.cacheWriteTokens = cacheWrite;
  return out;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
