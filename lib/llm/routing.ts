import type { LlmEnv } from "@/lib/env";
import { assertOrgEndpointShape } from "./endpoint-guard";
import {
  LlmError,
  type ChatTask,
  type Effort,
  type LlmProviderName,
  type LlmTask,
  type ResolvedRoute,
  type ReviewMode,
} from "./types";

/**
 * Per-task model routing (R6.15). Precedence for the model: per-call `model` > per-org override > task+mode env
 * (`LLM_MODEL_FAST` / `LLM_MODEL_DEEP`, review and verify only) > task env (`LLM_MODEL_<TASK>`) > `LLM_MODEL` >
 * the provider's built-in default. Effort comes from the call, else the built-in route for the task and mode.
 */

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const FAKE_MODEL = "fake-model";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
/** Model id of the default `FakeEmbeddings` (64 dimensions). */
export const FAKE_EMBEDDING_MODEL = "fake-embedding-64";

interface RouteDefault {
  model: string;
  effort?: Effort;
}

type TaskDefault = RouteDefault | Record<ReviewMode, RouteDefault>;

const SONNET = "claude-sonnet-5-5";
const OPUS = DEFAULT_ANTHROPIC_MODEL;
const HAIKU = "claude-haiku-4-5";

/** Built-in Anthropic routes. Haiku takes no effort setting. */
export const ANTHROPIC_ROUTES: Readonly<Record<ChatTask, TaskDefault>> = {
  review: {
    fast: { model: SONNET, effort: "low" },
    standard: { model: OPUS, effort: "medium" },
    deep: { model: OPUS, effort: "xhigh" },
  },
  verify: {
    fast: { model: SONNET, effort: "low" },
    standard: { model: OPUS, effort: "medium" },
    deep: { model: OPUS, effort: "high" },
  },
  summary: { model: SONNET, effort: "low" },
  knowledge: { model: SONNET, effort: "medium" },
  rules: { model: SONNET, effort: "low" },
  classify: { model: HAIKU },
  context: { model: HAIKU },
  chat: { model: OPUS, effort: "medium" },
};

/** Output ceiling per task (thinking counts toward it on Claude). */
export const DEFAULT_MAX_TOKENS: Readonly<Record<ChatTask, number>> = {
  review: 16_000,
  verify: 16_000,
  summary: 16_000,
  knowledge: 16_000,
  rules: 16_000,
  chat: 16_000,
  classify: 4_000,
  context: 8_000,
};

/** Output ceiling for calls that name no task. */
export const UNTASKED_MAX_TOKENS = 16_000;

/** `LLM_MODEL_REVIEW`, `LLM_MODEL_VERIFY`, ... */
export type TaskModelVar = `LLM_MODEL_${Uppercase<ChatTask>}`;

export const TASK_MODEL_ENV: Readonly<Record<ChatTask, TaskModelVar>> = {
  review: "LLM_MODEL_REVIEW",
  verify: "LLM_MODEL_VERIFY",
  summary: "LLM_MODEL_SUMMARY",
  classify: "LLM_MODEL_CLASSIFY",
  context: "LLM_MODEL_CONTEXT",
  chat: "LLM_MODEL_CHAT",
  knowledge: "LLM_MODEL_KNOWLEDGE",
  rules: "LLM_MODEL_RULES",
};

/** Bring-your-own LLM settings for one org (stored encrypted by the settings track). */
export interface OrgLlmOverride {
  provider: Exclude<LlmProviderName, "fake">;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

export interface RouteInput {
  task?: LlmTask | null;
  mode?: ReviewMode;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface RouteContext {
  env: LlmEnv;
  orgOverride?: OrgLlmOverride;
}

function isOpenAiHost(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/** `openai` pointed at another host (vLLM, Ollama, LM Studio, ...) behaves as `openai-compatible`. */
export function normalizeProvider(provider: LlmProviderName, baseURL: string | undefined): LlmProviderName {
  return provider === "openai" && baseURL && !isOpenAiHost(baseURL) ? "openai-compatible" : provider;
}

/** Provider, endpoint, and key a call runs against, and whether env model variables apply to it. */
export interface ProviderTarget {
  provider: LlmProviderName;
  baseURL?: string;
  apiKey?: string;
  /**
   * True unless an org override targets another provider or endpoint. Env model names and the operator's key
   * belong to the operator's provider, so they only apply when this is true.
   */
  matchesEnv: boolean;
  fromOrg: boolean;
  /**
   * The org supplied `baseURL` and it is not the operator's endpoint: requests go to an org-chosen host, so it is
   * SSRF-checked (`endpoint-guard.ts`) and must never receive operator credentials.
   */
  orgEndpoint: boolean;
}

export function providerTarget(ctx: RouteContext): ProviderTarget {
  const { env, orgOverride: org } = ctx;
  const envProvider = normalizeProvider(env.LLM_PROVIDER, env.LLM_BASE_URL);
  if (!org) {
    return withDefaultBase({ provider: envProvider, baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, matchesEnv: true, fromOrg: false, orgEndpoint: false });
  }
  const provider = normalizeProvider(org.provider, org.baseURL);
  const same = provider === envProvider && (!org.baseURL || org.baseURL === env.LLM_BASE_URL);
  const orgEndpoint = !!org.baseURL && org.baseURL !== env.LLM_BASE_URL;
  // The org's own endpoint is untrusted input: https, no credentials, no private IP literals (DNS is checked later).
  if (orgEndpoint && org.baseURL) assertOrgEndpointShape(org.baseURL, env.LLM_ALLOW_PRIVATE_ORG_ENDPOINTS);
  return withDefaultBase({
    provider,
    baseURL: org.baseURL ?? (same ? env.LLM_BASE_URL : undefined),
    // An org that brings its own endpoint never falls back to the operator's key.
    apiKey: org.apiKey ?? (same ? env.LLM_API_KEY : undefined),
    matchesEnv: same,
    fromOrg: true,
    orgEndpoint,
  });
}

function withDefaultBase(t: ProviderTarget): ProviderTarget {
  if (t.provider === "openai") return { ...t, baseURL: t.baseURL ?? OPENAI_BASE_URL };
  if (t.provider === "openrouter") return { ...t, baseURL: t.baseURL ?? OPENROUTER_BASE_URL };
  if (t.provider === "openai-compatible" && !t.baseURL) {
    throw new LlmError(
      t.fromOrg
        ? "the organization's LLM settings must include a base URL for the openai-compatible provider"
        : "LLM_BASE_URL is required for the openai-compatible provider",
    );
  }
  return t;
}

function builtinFor(task: ChatTask | null, mode: ReviewMode): RouteDefault {
  if (!task) return { model: DEFAULT_ANTHROPIC_MODEL };
  const d = ANTHROPIC_ROUTES[task];
  return "model" in d ? d : d[mode];
}

function hasModes(task: ChatTask | null): boolean {
  return task === "review" || task === "verify";
}

/** Resolves the route for a chat-model call. Throws LlmError when no model can be determined. */
export function resolveRoute(input: RouteInput, ctx: RouteContext): ResolvedRoute {
  const task = input.task ?? null;
  const mode = input.mode ?? "standard";
  if (task === "embed") return embeddingRoute(ctx.env, mode);
  const target = providerTarget(ctx);
  const { env } = ctx;
  const builtin = builtinFor(task, mode);

  let model: string | undefined;
  let source: ResolvedRoute["source"] = "builtin";
  const pick = (candidate: string | undefined, from: ResolvedRoute["source"]) => {
    if (model === undefined && candidate) {
      model = candidate;
      source = from;
    }
  };
  pick(input.model, "call");
  pick(ctx.orgOverride?.model, "org");
  if (target.matchesEnv) {
    if (hasModes(task) && mode === "fast") pick(env.LLM_MODEL_FAST, "task_mode_env");
    if (hasModes(task) && mode === "deep") pick(env.LLM_MODEL_DEEP, "task_mode_env");
    if (task) pick(env[TASK_MODEL_ENV[task]], "task_env");
    pick(env.LLM_MODEL, "default_env");
  }
  if (target.provider === "anthropic") pick(builtin.model, "builtin");
  if (target.provider === "fake") pick(FAKE_MODEL, "builtin");
  if (model === undefined) {
    const taskVar = task ? TASK_MODEL_ENV[task] : "";
    throw new LlmError(
      target.fromOrg && !target.matchesEnv
        ? `the organization's LLM settings must include a model for the ${target.provider} provider`
        : `LLM_MODEL${taskVar ? ` (or ${taskVar})` : ""} is required for the ${target.provider} provider; it has no built-in default model`,
    );
  }

  const usesEffort = target.provider === "anthropic" || target.provider === "fake";
  const effort = input.effort ?? (usesEffort && task ? builtin.effort : undefined);
  return {
    task,
    mode,
    provider: target.provider,
    model,
    ...(effort ? { effort } : {}),
    maxTokens: input.maxTokens ?? (task ? DEFAULT_MAX_TOKENS[task] : UNTASKED_MAX_TOKENS),
    source,
    ...(target.baseURL ? { baseURL: target.baseURL } : {}),
  };
}

/** The route a task runs with under `ctx` (the gateway's `routeFor` binds `ctx`). */
export function routeFor(ctx: RouteContext, task: LlmTask, mode: ReviewMode = "standard"): ResolvedRoute {
  return resolveRoute({ task, mode }, ctx);
}

/** The embedding model route (`EMBEDDING_PROVIDER` / `EMBEDDING_MODEL`). */
export function embeddingRoute(env: LlmEnv, mode: ReviewMode = "standard"): ResolvedRoute {
  const provider = normalizeProvider(env.EMBEDDING_PROVIDER, env.EMBEDDING_BASE_URL);
  const baseURL = provider === "openai" ? (env.EMBEDDING_BASE_URL ?? OPENAI_BASE_URL) : env.EMBEDDING_BASE_URL;
  if (provider === "openai-compatible" && !baseURL) {
    throw new LlmError("EMBEDDING_BASE_URL is required for the openai-compatible embedding provider");
  }
  const builtin = provider === "openai" ? DEFAULT_OPENAI_EMBEDDING_MODEL : provider === "fake" ? FAKE_EMBEDDING_MODEL : undefined;
  const model = env.EMBEDDING_MODEL ?? builtin;
  if (!model) throw new LlmError(`EMBEDDING_MODEL is required for the ${provider} embedding provider`);
  const source = env.EMBEDDING_MODEL ? "default_env" : "builtin";
  return { task: "embed", mode, provider, model, maxTokens: 0, source, ...(baseURL ? { baseURL } : {}) };
}
