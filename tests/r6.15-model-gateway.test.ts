import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { modelCalls } from "@/lib/db/schema";
import { setLogSink } from "@/lib/log";
import { createGateway, type GatewayOptions } from "@/lib/llm/gateway";
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import { InMemoryModelCallRecorder, PostgresModelCallRecorder, modelCallTotals } from "@/lib/llm/recorder";
import { AnthropicProvider, anthropicRequest, type AnthropicMessagesApi, type AnthropicRequestOptions } from "@/lib/llm/anthropic";
import { isNonPublicAddress } from "@/lib/llm/endpoint-guard";
import { backoffDelay, parseRetryAfter } from "@/lib/llm/retry";
import {
  LlmAbortError,
  LlmError,
  LlmRefusalError,
  LlmValidationError,
  type LlmProvider,
  type ReviewMode,
} from "@/lib/llm/types";
import { createTestDb } from "./helpers/db";
import { anthropicMessage, chatCompletion, fakeFetch, jsonResponse, type Responder } from "./helpers/fake-fetch";
import { seedReviewRuns } from "./helpers/review-runs";

const findingsSchema = z.object({ findings: z.array(z.object({ title: z.string(), line: z.number() })) });
const FINDINGS = { findings: [{ title: "Null deref", line: 12 }] };
const noSleep = async () => undefined;
/** DNS that maps every host to a public address (the SSRF check never touches the network in tests). */
const PUBLIC_DNS = async () => ["93.184.215.14"];

function sleeps() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

/** A gateway on the real Anthropic SDK, whose HTTP goes to `responder`. */
function anthropicGateway(responder: Responder, opts: Omit<GatewayOptions, "anthropic"> = {}) {
  const http = fakeFetch(responder);
  const sdk = new Anthropic({ apiKey: "sk-ant-test-key-0000000000", fetch: http.fetch, maxRetries: 0 });
  const recorder = new InMemoryModelCallRecorder();
  const gateway = createGateway({ env: { LLM_PROVIDER: "anthropic" }, recorder, sleep: noSleep, ...opts, anthropic: sdk.beta.messages });
  return { gateway, http, recorder };
}

function openAiGateway(env: GatewayOptions["env"], responder: Responder, opts: Omit<GatewayOptions, "fetch" | "env"> = {}) {
  const http = fakeFetch(responder);
  const recorder = new InMemoryModelCallRecorder();
  const gateway = createGateway({ env, recorder, sleep: noSleep, fetch: http.fetch, ...opts });
  return { gateway, http, recorder };
}

/** A provider whose attempts follow a script of results/errors. */
function scriptedProvider(script: (attempt: number, call: FakeCall) => unknown): FakeLlm {
  let attempt = 0;
  return new FakeLlm((call) => {
    const out = script(attempt++, call);
    if (out instanceof Error) throw out;
    return out;
  });
}

let restoreLog: (() => void) | undefined;
afterEach(() => {
  restoreLog?.();
  restoreLog = undefined;
});

describe("model gateway routing", () => {
  test("R6.15 routes every task and review mode to its built-in Anthropic model, effort, and output limit", () => {
    const g = createGateway({ env: { LLM_PROVIDER: "anthropic" } });
    const pick = (task: Parameters<typeof g.routeFor>[0], mode?: ReviewMode) => {
      const r = g.routeFor(task, mode);
      return { model: r.model, effort: r.effort };
    };
    expect(pick("review", "fast")).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(pick("review", "standard")).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(pick("review", "deep")).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
    expect(pick("verify", "fast")).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(pick("verify", "standard")).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(pick("verify", "deep")).toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(pick("summary")).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(pick("knowledge")).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(pick("rules")).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(pick("classify")).toEqual({ model: "claude-haiku-4-5", effort: undefined });
    expect(pick("context")).toEqual({ model: "claude-haiku-4-5", effort: undefined });
    expect(pick("chat")).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    // Modes only change review and verify.
    expect(pick("summary", "deep")).toEqual(pick("summary", "fast"));
    expect(g.routeFor("review")).toMatchObject({ task: "review", mode: "standard", provider: "anthropic", source: "builtin", maxTokens: 16_000 });
    expect(g.routeFor("classify").maxTokens).toBe(4_000);
    expect(g.routeFor("embed")).toMatchObject({ task: "embed", provider: "openai", model: "text-embedding-3-small" });
    expect(g.model).toBe("claude-opus-5-5");
  });

  test("R6.15 env model overrides apply with per-call > task+mode > task > LLM_MODEL > built-in precedence", async () => {
    const env = {
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-opus-5",
      LLM_MODEL_REVIEW: "claude-sonnet-5",
      LLM_MODEL_CLASSIFY: "claude-sonnet-5-5",
      LLM_MODEL_FAST: "claude-haiku-4-5",
      LLM_MODEL_DEEP: "claude-fable-5-1",
    };
    const fake = new FakeLlm(() => FINDINGS);
    const g = createGateway({ env, provider: fake });
    expect(g.routeFor("review", "fast")).toMatchObject({ model: "claude-haiku-4-5", source: "task_mode_env", effort: "low" });
    expect(g.routeFor("review", "deep")).toMatchObject({ model: "claude-fable-5-1", source: "task_mode_env", effort: "xhigh" });
    expect(g.routeFor("review", "standard")).toMatchObject({ model: "claude-sonnet-5", source: "task_env" });
    expect(g.routeFor("verify", "fast")).toMatchObject({ model: "claude-haiku-4-5", source: "task_mode_env" });
    expect(g.routeFor("verify", "standard")).toMatchObject({ model: "claude-opus-5", source: "default_env" });
    expect(g.routeFor("classify")).toMatchObject({ model: "claude-sonnet-5-5", source: "task_env" });
    // LLM_MODEL_FAST / _DEEP are review and verify settings only.
    expect(g.routeFor("summary", "fast")).toMatchObject({ model: "claude-opus-5", source: "default_env" });
    expect(g.routeFor("chat", "deep")).toMatchObject({ model: "claude-opus-5", source: "default_env" });
    expect(createGateway({ env: { LLM_PROVIDER: "anthropic" } }).routeFor("summary")).toMatchObject({ source: "builtin" });

    const res = await g.json({
      system: "s",
      prompt: "p",
      schema: findingsSchema,
      schemaName: "review_findings",
      task: "review",
      mode: "deep",
      model: "claude-opus-5-5",
      effort: "max",
    });
    expect(res.route).toMatchObject({ model: "claude-opus-5-5", source: "call", effort: "max", task: "review", mode: "deep" });
    expect(fake.calls[0]!.req).toMatchObject({ model: "claude-opus-5-5", effort: "max", maxTokens: 16_000 });
    expect(res.data).toEqual(FINDINGS);
  });

  test("R6.15 a per-org override beats env routing and can switch provider (bring your own LLM)", async () => {
    const env = { LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-operator-key-000000", LLM_MODEL_REVIEW: "claude-sonnet-5" };
    // Same provider with the org's own key: env task routing still applies.
    const sameProvider = createGateway({ env, orgOverride: { provider: "anthropic", apiKey: "sk-ant-org-key-0000000000" } });
    expect(sameProvider.routeFor("review")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", source: "task_env" });
    // The org's model wins over env routing for every task.
    const pinned = createGateway({ env, orgOverride: { provider: "anthropic", model: "claude-opus-5" } });
    expect(pinned.routeFor("review")).toMatchObject({ model: "claude-opus-5", source: "org" });
    expect(pinned.routeFor("classify")).toMatchObject({ model: "claude-opus-5", source: "org" });

    // Switching provider ignores env model names (they belong to the operator's provider).
    const http = fakeFetch(() => jsonResponse(chatCompletion(JSON.stringify(FINDINGS))));
    const byo = createGateway({
      env,
      orgOverride: { provider: "openai-compatible", baseURL: "https://llm.acme.dev/v1", model: "acme-coder", apiKey: "acme-key" },
      fetch: http.fetch,
      resolveHost: PUBLIC_DNS,
      sleep: noSleep,
    });
    const res = await byo.json({ system: "s", prompt: "p", schema: findingsSchema, schemaName: "review_findings", task: "review" });
    expect(res.route).toMatchObject({ provider: "openai-compatible", model: "acme-coder", source: "org", baseURL: "https://llm.acme.dev/v1" });
    expect(res.route.effort).toBeUndefined();
    expect(http.requests[0]!.url).toBe("https://llm.acme.dev/v1/chat/completions");
    expect(http.requests[0]!.headers.authorization).toBe("Bearer acme-key");
    // The operator's key never goes to an org's endpoint.
    expect(JSON.stringify(http.requests[0]!.headers)).not.toContain("operator");

    const noModel = createGateway({ env, orgOverride: { provider: "openai", apiKey: "k" } });
    expect(() => noModel.routeFor("review")).toThrow(/organization's LLM settings must include a model for the openai provider/);
    // An org endpoint without its own key is refused rather than handed the operator's key.
    const proxy = anthropicGateway(() => jsonResponse(anthropicMessage({ text: "x" })), {
      env,
      orgOverride: { provider: "anthropic", baseURL: "https://llm-proxy.acme.dev" },
    });
    await expect(proxy.gateway.text({ system: "s", prompt: "p", task: "chat" })).rejects.toThrow(/must include an API key for the anthropic provider/);
    expect(proxy.http.requests).toHaveLength(0);
    expect(proxy.recorder.calls[0]).toMatchObject({ status: "error", attempts: 0 });
    // Per-call model still wins over the org's model.
    const fake = new FakeLlm(() => "ok");
    const perCall = createGateway({ env, orgOverride: { provider: "anthropic", model: "claude-opus-5" }, provider: fake });
    expect((await perCall.text({ system: "s", prompt: "p", task: "chat", model: "claude-haiku-4-5" })).route.model).toBe("claude-haiku-4-5");
  });

  test("R6.15 OpenAI-style providers require a configured model; openai with another base URL is openai-compatible", () => {
    const openai = createGateway({ env: { LLM_PROVIDER: "openai", LLM_API_KEY: "k" } });
    expect(() => openai.routeFor("review")).toThrow(/LLM_MODEL \(or LLM_MODEL_REVIEW\) is required for the openai provider/);
    const perTask = createGateway({ env: { LLM_PROVIDER: "openrouter", LLM_API_KEY: "k", LLM_MODEL_REVIEW: "vendor/model-a" } });
    expect(perTask.routeFor("review")).toMatchObject({ provider: "openrouter", model: "vendor/model-a", baseURL: "https://openrouter.ai/api/v1" });
    expect(() => perTask.routeFor("summary")).toThrow(/LLM_MODEL \(or LLM_MODEL_SUMMARY\) is required for the openrouter provider/);
    const official = createGateway({ env: { LLM_PROVIDER: "openai", LLM_MODEL: "example-model", LLM_API_KEY: "k" } });
    expect(official.routeFor("chat")).toMatchObject({ provider: "openai", baseURL: "https://api.openai.com/v1" });
    const local = createGateway({ env: { LLM_PROVIDER: "openai", LLM_MODEL: "llama", LLM_BASE_URL: "http://localhost:11434/v1" } });
    expect(local.routeFor("chat")).toMatchObject({ provider: "openai-compatible", baseURL: "http://localhost:11434/v1" });
    expect(() => createGateway({ env: { LLM_PROVIDER: "openai-compatible", LLM_MODEL: "m" } }).routeFor("chat")).toThrow(
      /LLM_BASE_URL is required for the openai-compatible provider/,
    );
  });
});

describe("Anthropic request shaping", () => {
  test("R6.15 Haiku requests carry no effort, no fallbacks, and no fallback beta", async () => {
    const { gateway, http } = anthropicGateway(() =>
      jsonResponse(anthropicMessage({ model: "claude-haiku-4-5", text: JSON.stringify({ label: "bugfix" }) })),
    );
    const res = await gateway.json({
      system: "Classify the PR.",
      prompt: "diff",
      schema: z.object({ label: z.string() }),
      schemaName: "pr_class",
      task: "classify",
      effort: "high",
    });
    expect(res.data).toEqual({ label: "bugfix" });
    const req = http.requests[0]!;
    expect(req.url).toMatch(/\/v1\/messages\?beta=true$/);
    const body = req.body as Record<string, unknown> & { output_config?: Record<string, unknown> };
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body).not.toHaveProperty("fallbacks");
    expect(body).not.toHaveProperty("betas");
    expect(body.output_config).not.toHaveProperty("effort");
    expect(body.output_config).toHaveProperty("format.type", "json_schema");
    expect(req.headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback");

    const text = await gateway.text({ system: "s", prompt: "p", task: "context" });
    expect(http.requests[1]!.body).not.toHaveProperty("output_config");
    expect(http.requests[1]!.headers["anthropic-beta"]).toBeUndefined();
    expect(text.text).toBe(JSON.stringify({ label: "bugfix" }));
  });

  test("R6.15 Opus 5.5 requests carry the fallback beta, fallbacks default, effort, a cached system prompt, and no prefill; cache tokens are captured", async () => {
    const { gateway, http, recorder } = anthropicGateway(() =>
      jsonResponse(
        anthropicMessage({
          text: JSON.stringify(FINDINGS),
          usage: { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 2_000 },
        }),
      ),
    );
    const res = await gateway.json({ system: "You review code.", prompt: "diff", schema: findingsSchema, schemaName: "review_findings", task: "review", mode: "deep" });
    expect(res.data).toEqual(FINDINGS);
    expect(res.usage).toEqual({ inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 4_000, cacheWriteTokens: 2_000 });
    const req = http.requests[0]!;
    const body = req.body as Record<string, unknown>;
    expect(req.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      fallbacks: "default",
      output_config: { effort: "xhigh", format: { type: "json_schema" } },
      system: [{ type: "text", text: "You review code.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "diff" }],
    });
    expect(body).not.toHaveProperty("thinking");
    expect(recorder.calls[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cacheReadTokens: 4_000,
      cacheWriteTokens: 2_000,
      // 1000 * $4 + 500 * $20 + 4000 * $0.20 + 2000 * $5, per million tokens.
      costUsd: 0.0248,
    });

    // Text calls use messages.create with the same shaping; Sonnet 5 takes effort but not the fallback chain.
    await gateway.text({ system: "s", prompt: "p", task: "chat", model: "claude-sonnet-5", effort: "low" });
    const textReq = http.requests[1]!;
    expect(textReq.body).toMatchObject({ model: "claude-sonnet-5", output_config: { effort: "low" } });
    expect(textReq.body).not.toHaveProperty("fallbacks");
    expect(anthropicRequest("claude-fable-5-1", { system: "s", prompt: "p" }, "medium")).toMatchObject({
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
    });
    // An unfamiliar model id gets the request every model accepts.
    expect(anthropicRequest("claude-future-9", { system: "s", prompt: "p", effort: "high" }, "medium")).not.toHaveProperty("output_config");
  });

  test("R6.15 a refusal from the fallback chain is an LlmRefusalError, never retried, recorded as refused", async () => {
    const { gateway, http, recorder } = anthropicGateway(() =>
      jsonResponse(anthropicMessage({ stopReason: "refusal", explanation: "declined by policy" })),
    );
    const err = await gateway.json({ system: "s", prompt: "p", schema: findingsSchema, schemaName: "f", task: "review" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect(err.message).toBe("declined by policy");
    expect(http.requests).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({ status: "refused", attempts: 1, inputTokens: 100, error: "declined by policy" });
  });

  test("R6.15 Anthropic API errors map to retry decisions with retry-after; the SDK itself never retries", async () => {
    const { delays, sleep } = sleeps();
    const { gateway, http, recorder } = anthropicGateway(
      (_req, i) =>
        i === 0
          ? jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "3" })
          : i === 1
            ? jsonResponse({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }, 529)
            : jsonResponse(anthropicMessage({ text: "done" })),
      { sleep, random: () => 0 },
    );
    const res = await gateway.text({ system: "s", prompt: "p", task: "chat" });
    expect(res.text).toBe("done");
    expect(res.attempts).toBe(3);
    expect(http.requests).toHaveLength(3);
    expect(delays).toEqual([3_000, 0]);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({ status: "ok", attempts: 3 });

    const bad = anthropicGateway(() => jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400));
    const err = await bad.gateway.text({ system: "s", prompt: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(400);
    expect(bad.http.requests).toHaveLength(1);
  });

  test("R6.15 AnthropicProvider is usable directly with an injected client", async () => {
    const http = fakeFetch(() => jsonResponse(anthropicMessage({ model: "claude-opus-5", text: JSON.stringify(FINDINGS) })));
    const provider = new AnthropicProvider({
      messages: new Anthropic({ apiKey: "sk-ant-test-key-0000000000", fetch: http.fetch, maxRetries: 0 }).beta.messages,
    });
    const res = await provider.json({ system: "s", prompt: "p", schema: findingsSchema, schemaName: "f" });
    // The server-side fallback served the turn on another model; the provider reports it.
    expect(res.servedModel).toBe("claude-opus-5");
    expect(http.requests[0]!.body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" } });
  });
});

describe("OpenAI-style providers", () => {
  test("R6.15 OpenAI requests use the official endpoint, a bearer key, json_schema, and max_completion_tokens", async () => {
    const { gateway, http } = openAiGateway({ LLM_PROVIDER: "openai", LLM_MODEL: "example-model", LLM_API_KEY: "sk-openai-test" }, () =>
      jsonResponse(chatCompletion(JSON.stringify(FINDINGS), { usage: { prompt_tokens: 300, completion_tokens: 40, cached: 100 } })),
    );
    const res = await gateway.json({ system: "sys", prompt: "user", schema: findingsSchema, schemaName: "review findings", task: "review" });
    expect(res.data).toEqual(FINDINGS);
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 100 });
    const req = http.requests[0]!;
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-openai-test");
    expect(req.body).toMatchObject({
      model: "example-model",
      max_completion_tokens: 16_000,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "user" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "review_findings", strict: false, schema: { type: "object" } } },
    });
    expect(req.body).not.toHaveProperty("max_tokens");
  });

  test("R6.15 OpenRouter requests carry the app attribution headers", async () => {
    const { gateway, http } = openAiGateway(
      { LLM_PROVIDER: "openrouter", LLM_MODEL: "vendor/model-a", LLM_API_KEY: "or-key", APP_URL: "https://review.acme.dev" },
      () => jsonResponse(chatCompletion("hello")),
    );
    const res = await gateway.text({ system: "s", prompt: "p", task: "chat" });
    expect(res.text).toBe("hello");
    const req = http.requests[0]!;
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.headers["http-referer"]).toBe("https://review.acme.dev");
    expect(req.headers["x-title"]).toBe("OpenReview");
    expect(req.headers.authorization).toBe("Bearer or-key");
    expect(req.body).toMatchObject({ model: "vendor/model-a", max_tokens: 16_000 });
    expect(req.body).not.toHaveProperty("response_format");
  });

  test("R6.15 an OpenAI-compatible server falls back from json_schema to json_object to a schema in the prompt", async () => {
    const { gateway, http } = openAiGateway({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://localhost:8000/v1/", LLM_MODEL: "qwen-coder" }, (_req, i) =>
      i === 0
        ? jsonResponse({ error: { message: "response_format type json_schema is not supported" } }, 400)
        : i === 1
          ? jsonResponse({ error: { message: "Unknown response_format: json_object" } }, 422)
          : jsonResponse(chatCompletion("Here you go:\n```json\n" + JSON.stringify(FINDINGS) + "\n```")),
    );
    const req = { system: "sys", prompt: "user", schema: findingsSchema, schemaName: "review_findings", task: "review" as const };
    expect((await gateway.json(req)).data).toEqual(FINDINGS);
    expect(http.requests.map((r) => (r.body as { response_format?: { type: string } }).response_format?.type)).toEqual([
      "json_schema",
      "json_object",
      undefined,
    ]);
    const promptMode = http.requests[2]!.body as { messages: { content: string }[] };
    expect(promptMode.messages[0]!.content).toContain("<json_schema>");
    expect(promptMode.messages[0]!.content).toContain('"findings"');
    expect(http.requests[2]!.url).toBe("http://localhost:8000/v1/chat/completions");
    expect(http.requests[2]!.headers.authorization).toBeUndefined();
    // The working mode is remembered for the model.
    await gateway.json(req);
    expect(http.requests).toHaveLength(4);
    expect(http.requests[3]!.body).not.toHaveProperty("response_format");
  });
});

describe("reliability", () => {
  test("R6.15 retries 408/409/429/5xx and network errors with exponential backoff, full jitter, and retry-after", async () => {
    const { delays, sleep } = sleeps();
    const statuses = [429, 503, 408, 409];
    const { gateway, http, recorder } = openAiGateway(
      { LLM_PROVIDER: "openai", LLM_MODEL: "example-model", LLM_API_KEY: "k", LLM_MAX_RETRIES: "5" },
      (_req, i) => {
        if (i === 4) return new TypeError("fetch failed");
        if (i < statuses.length) return jsonResponse({ error: { message: "busy" } }, statuses[i]!, i === 0 ? { "retry-after": "7" } : {});
        return jsonResponse(chatCompletion("ok"));
      },
      { sleep, random: () => 0.5 },
    );
    const res = await gateway.text({ system: "s", prompt: "p", task: "chat" });
    expect(res.text).toBe("ok");
    expect(http.requests).toHaveLength(6);
    // retry-after (7 s) beats the jitter; then half of 2 s, 4 s, 8 s, 16 s windows.
    expect(delays).toEqual([7_000, 1_000, 2_000, 4_000, 8_000]);
    expect(recorder.calls[0]).toMatchObject({ status: "ok", attempts: 6 });

    expect(backoffDelay(10, undefined, { random: () => 0.999 })).toBeLessThan(30_000);
    expect(backoffDelay(0, 600_000, { random: () => 0 })).toBe(120_000);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(parseRetryAfter({ "Retry-After": "Wed, 21 Oct 2026 07:28:10 GMT" }, Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(10_000);
  });

  test("R6.15 does not retry 400, 401, 403, 404, or refusals", async () => {
    for (const status of [400, 401, 403, 404]) {
      const { gateway, http, recorder } = openAiGateway({ LLM_PROVIDER: "openai", LLM_MODEL: "m", LLM_API_KEY: "k" }, () =>
        jsonResponse({ error: { message: "nope" } }, status),
      );
      const err = await gateway.text({ system: "s", prompt: "p" }).catch((e) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(err.status).toBe(status);
      expect(http.requests).toHaveLength(1);
      expect(recorder.calls[0]).toMatchObject({ status: "error", attempts: 1 });
      expect(recorder.calls[0]!.error).toContain(String(status));
    }
    const { gateway, http, recorder } = openAiGateway({ LLM_PROVIDER: "openai", LLM_MODEL: "m", LLM_API_KEY: "k" }, () =>
      jsonResponse(chatCompletion(null, { refusal: "I can't help with that." })),
    );
    const err = await gateway.json({ system: "s", prompt: "p", schema: findingsSchema, schemaName: "f" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect(http.requests).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({ status: "refused", attempts: 1 });
  });

  test("R6.15 stops after LLM_MAX_RETRIES and records the failure", async () => {
    const { gateway, http, recorder } = openAiGateway({ LLM_PROVIDER: "openai", LLM_MODEL: "m", LLM_API_KEY: "k", LLM_MAX_RETRIES: "2" }, () =>
      jsonResponse({ error: { message: "upstream unavailable" } }, 503),
    );
    const err = await gateway.text({ system: "s", prompt: "p", task: "chat" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(http.requests).toHaveLength(3);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({ status: "error", attempts: 3, task: "chat" });
    expect(recorder.calls[0]!.error).toContain("503");
  });

  test("R6.15 a slow attempt times out (LLM_TIMEOUT_MS) and is retried; cancellation is not", async () => {
    const signals: AbortSignal[] = [];
    let attempt = 0;
    const slowOnce: LlmProvider = {
      name: "slow",
      model: "slow-model",
      json: () => Promise.reject(new Error("unused")),
      text: (req) => {
        signals.push(req.signal!);
        // First attempt never answers; the gateway must give up on it.
        return attempt++ === 0 ? new Promise(() => undefined) : Promise.resolve({ text: "second", usage: { inputTokens: 1, outputTokens: 1 } });
      },
    };
    const recorder = new InMemoryModelCallRecorder();
    const g = createGateway({ env: { LLM_PROVIDER: "fake", LLM_TIMEOUT_MS: "25", LLM_MIN_OUTPUT_TOKENS_PER_SEC: "0" }, provider: slowOnce, recorder, sleep: noSleep });
    const res = await g.text({ system: "s", prompt: "p" });
    expect(res.text).toBe("second");
    expect(res.attempts).toBe(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    const hang: LlmProvider = { ...slowOnce, text: () => new Promise(() => undefined) };
    const cancelled = createGateway({ env: { LLM_PROVIDER: "fake", LLM_TIMEOUT_MS: "60000" }, provider: hang, recorder, sleep: noSleep });
    const controller = new AbortController();
    const pending = cancelled.text({ system: "s", prompt: "p", signal: controller.signal }).catch((e) => e);
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(LlmAbortError);
    expect(recorder.calls.at(-1)).toMatchObject({ status: "error", attempts: 1 });
  });

  test("R6.15 invalid structured output gets one corrective retry with the validation error, then LlmError", async () => {
    const fixed = scriptedProvider((i) => (i === 0 ? { findings: [{ title: "x", line: "twelve" }] } : FINDINGS));
    const recorder = new InMemoryModelCallRecorder();
    const g = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: fixed, recorder, sleep: noSleep });
    const res = await g.json({ system: "s", prompt: "original prompt", schema: findingsSchema, schemaName: "review_findings", task: "review" });
    expect(res.data).toEqual(FINDINGS);
    expect(res.attempts).toBe(2);
    const second = fixed.calls[1]!.req.prompt;
    expect(second.startsWith("original prompt")).toBe(true);
    expect(second).toContain("<previous_output_error>");
    expect(second).toContain("review_findings");
    expect(second).toMatch(/expected number/i);
    // Tokens from the rejected attempt count toward the call (FakeLlm charges ceil(chars / 4)).
    const expectedInput = Math.ceil("soriginal prompt".length / 4) + Math.ceil(("s" + second).length / 4);
    expect(res.usage.inputTokens).toBe(expectedInput);
    expect(recorder.calls[0]).toMatchObject({ inputTokens: expectedInput, attempts: 2, status: "ok" });

    const neverValid = scriptedProvider(() => ({ findings: "none" }));
    const g2 = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: neverValid, recorder, sleep: noSleep });
    const err = await g2.json({ system: "s", prompt: "p", schema: findingsSchema, schemaName: "review_findings" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
    expect(err).toBeInstanceOf(LlmError);
    expect(neverValid.calls).toHaveLength(2);
    expect(recorder.calls.at(-1)).toMatchObject({ status: "error", attempts: 2 });
  });
});

describe("accounting", () => {
  test("R6.15 records one model_calls row per call with tokens, latency, cost, status, attempts, and correlation ids", async () => {
    const db = await createTestDb();
    let clock = 1_000;
    const { gateway } = anthropicGateway(
      (_req, i) =>
        i === 0
          ? jsonResponse({ type: "error", error: { type: "api_error", message: "boom" } }, 500)
          : jsonResponse(anthropicMessage({ model: "claude-sonnet-5-5", text: "summary", usage: { input_tokens: 2_000, output_tokens: 300 } })),
      { recorder: new PostgresModelCallRecorder(db), now: () => (clock += 400) },
    );
    const [runId] = (await seedReviewRuns(db, "org_a")) as [number];
    const meta = { orgId: "org_a", repoId: 7, reviewRunId: runId, agentRunId: 3 };
    const res = await gateway.text({ system: "s", prompt: "p", task: "summary", mode: "fast", meta });
    expect(res.route).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "low", task: "summary", mode: "fast" });

    const rows = await db.select().from(modelCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: "org_a",
      repoId: 7,
      reviewRunId: runId,
      agentRunId: 3,
      task: "summary",
      mode: "fast",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      inputTokens: 2_000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 400,
      costUsd: 0.007,
      status: "ok",
      error: null,
      attempts: 2,
    });

    // Unpriced models are recorded with an unknown cost, never 0.
    const fake = new FakeLlm(() => "x");
    await createGateway({ env: { LLM_PROVIDER: "fake" }, provider: fake, recorder: new PostgresModelCallRecorder(db) }).text({
      system: "s",
      prompt: "p",
      meta: { orgId: "org_a", reviewRunId: runId },
    });
    const totals = await modelCallTotals(db, "org_a", { reviewRunId: runId });
    expect(totals).toMatchObject({ calls: 2, inputTokens: 2_001, costUsd: 0.007, unpricedCalls: 1 });
    const [unpriced] = await db.select().from(modelCalls).where(eq(modelCalls.model, "fake-model"));
    expect(unpriced).toMatchObject({ costUsd: null, task: "unspecified", status: "ok", attempts: 1 });
  });

  test("R6.15 a failing recorder is logged and never fails the model call", async () => {
    const lines: string[] = [];
    restoreLog = setLogSink((line) => void lines.push(line));
    const g = createGateway({
      env: { LLM_PROVIDER: "fake" },
      provider: new FakeLlm(() => "fine"),
      recorder: { record: () => Promise.reject(new Error("db down")) },
    });
    expect((await g.text({ system: "s", prompt: "p", task: "chat" })).text).toBe("fine");
    expect(lines.some((l) => l.includes("failed to record model call") && l.includes("db down"))).toBe(true);
  });

  test("R6.15 existing callers keep working: a gateway over FakeLlm serves the review engine and records its calls", async () => {
    const { reviewFixture } = await import("./helpers/review-fixture");
    const { runReviewJob } = await import("@/lib/review/run");
    const fx = await reviewFixture();
    try {
      const { engineLlm } = await import("./helpers/engine");
      // A fake model answering every engine task (classify, review, verify, summary) with valid output.
      const fake = engineLlm();
      const recorder = new PostgresModelCallRecorder(fx.db);
      const gateway = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: fake, recorder });
      await runReviewJob({ db: fx.db, host: fx.host, llm: gateway, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
      const rows = await fx.db.select().from(modelCalls);
      expect(rows.length).toBe(fake.calls.length);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((r) => r.status === "ok" && r.provider === "fake")).toBe(true);
    } finally {
      fx.fixture.cleanup();
    }
  });
});

describe("bring-your-own endpoint safety", () => {
  const OPERATOR_ENV = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"] as const;

  test("R6.15 an org's own Anthropic key or endpoint never receives the operator's env token, headers, or base URL", async () => {
    const saved = Object.fromEntries(OPERATOR_ENV.map((k) => [k, process.env[k]]));
    process.env.ANTHROPIC_AUTH_TOKEN = "operator-secret-token";
    process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Operator-Tenant: operator-tenant\nX-Operator-Route: operator-route";
    process.env.ANTHROPIC_BASE_URL = "https://operator-proxy.example.com";
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator-env-key";
    try {
      const http = fakeFetch(() => jsonResponse(anthropicMessage({ text: "hi" })));
      const env = { LLM_PROVIDER: "anthropic" };
      const ask = (g: ReturnType<typeof createGateway>) => g.text({ system: "s", prompt: "p", task: "chat" });

      // The real SDK, built by the gateway: an org endpoint gets the org key and nothing of the operator's.
      await ask(
        createGateway({
          env,
          orgOverride: { provider: "anthropic", baseURL: "https://llm-proxy.acme.dev", apiKey: "sk-ant-org-key-0000000000" },
          fetch: http.fetch,
          resolveHost: PUBLIC_DNS,
          sleep: noSleep,
        }),
      );
      const org = http.requests[0]!;
      expect(org.url).toMatch(/^https:\/\/llm-proxy\.acme\.dev\/v1\/messages/);
      expect(org.headers["x-api-key"]).toBe("sk-ant-org-key-0000000000");
      expect(org.headers.authorization).toBeUndefined();
      expect(org.headers["x-operator-tenant"]).toBeUndefined();
      expect(JSON.stringify(org.headers)).not.toContain("operator");
      // A non-first-party endpoint never gets the first-party-only fallback beta.
      expect(org.body).not.toHaveProperty("fallbacks");
      expect(org.headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback");

      // The org's own key on the operator's provider goes to the first-party API, not ANTHROPIC_BASE_URL.
      await ask(createGateway({ env, orgOverride: { provider: "anthropic", apiKey: "sk-ant-org-key-0000000000" }, fetch: http.fetch, sleep: noSleep }));
      const ownKey = http.requests[1]!;
      expect(ownKey.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
      expect(ownKey.headers.authorization).toBeUndefined();
      expect(JSON.stringify(ownKey.headers)).not.toContain("operator");
      expect(ownKey.body).toMatchObject({ fallbacks: "default" });

      // The operator's own calls keep the SDK's env configuration (behind a proxy: no fallback beta).
      await ask(createGateway({ env, fetch: http.fetch, sleep: noSleep }));
      const operator = http.requests[2]!;
      expect(operator.url).toMatch(/^https:\/\/operator-proxy\.example\.com\/v1\/messages/);
      expect(operator.headers.authorization).toBe("Bearer operator-secret-token");
      expect(operator.body).not.toHaveProperty("fallbacks");

      expect(() => new AnthropicProvider({ orgScoped: true, baseURL: "https://llm-proxy.acme.dev" })).toThrow(/organization's own API key/);
    } finally {
      for (const k of OPERATOR_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test("R6.15 an org's own endpoint must be https and public: private, loopback, link-local, and metadata targets are refused", async () => {
    const http = fakeFetch(() => jsonResponse(chatCompletion("ok")));
    const recorder = new InMemoryModelCallRecorder();
    const env = { LLM_PROVIDER: "anthropic" };
    const org = (baseURL: string) => ({ provider: "openai-compatible" as const, baseURL, model: "acme-coder", apiKey: "acme-key" });
    const ask = (g: ReturnType<typeof createGateway>) => g.text({ system: "s", prompt: "p", task: "chat" });

    for (const bad of [
      "http://llm.acme.dev/v1",
      "https://user:pw@llm.acme.dev/v1",
      "https://127.0.0.1/v1",
      "https://2130706433/v1",
      "https://10.1.2.3/v1",
      "https://172.18.0.3:6379/v1",
      "https://192.168.1.10/v1",
      "https://100.64.0.1/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "https://[fd00:ec2::254]/v1",
      "https://[fe80::1]/v1",
      "https://localhost/v1",
      "https://api.localhost/v1",
      "not a url",
    ]) {
      const g = createGateway({ env, orgOverride: org(bad), fetch: http.fetch, resolveHost: PUBLIC_DNS, sleep: noSleep, recorder });
      await expect(ask(g), bad).rejects.toThrow(LlmError);
    }

    // Hostnames are resolved: any private answer is refused (internal service names, metadata aliases, mixed sets).
    const resolved: Record<string, string[]> = {
      redis: ["172.18.0.3"],
      "metadata.google.internal": ["169.254.169.254"],
      "mixed.acme.dev": ["93.184.215.14", "10.0.0.5"],
      "v6.acme.dev": ["fe80::1"],
    };
    for (const [host, addresses] of Object.entries(resolved)) {
      const g = createGateway({ env, orgOverride: org(`https://${host}/v1`), fetch: http.fetch, resolveHost: async () => addresses, sleep: noSleep, recorder });
      await expect(ask(g), host).rejects.toThrow(/resolves to a private, loopback, or link-local address/);
    }
    const unresolvable = createGateway({
      env,
      orgOverride: org("https://nowhere.acme.dev/v1"),
      fetch: http.fetch,
      resolveHost: async () => Promise.reject(new Error("ENOTFOUND")),
      sleep: noSleep,
      recorder,
    });
    await expect(ask(unresolvable)).rejects.toThrow(/cannot resolve/);
    expect(http.requests).toHaveLength(0);
    expect(recorder.calls.length).toBeGreaterThan(0);
    expect(recorder.calls.every((c) => c.status === "error" && c.attempts === 0)).toBe(true);

    // A public host is allowed, and resolved once per gateway.
    let lookups = 0;
    const ok = createGateway({
      env,
      orgOverride: org("https://llm.acme.dev/v1"),
      fetch: http.fetch,
      resolveHost: async () => {
        lookups++;
        return ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"];
      },
      sleep: noSleep,
    });
    await ask(ok);
    await ask(ok);
    expect(lookups).toBe(1);
    expect(http.requests.map((r) => r.url)).toEqual(["https://llm.acme.dev/v1/chat/completions", "https://llm.acme.dev/v1/chat/completions"]);

    // Operators can let orgs use internal endpoints; credentials in the URL are still refused.
    const noDns = async (): Promise<string[]> => Promise.reject(new Error("DNS must not be needed"));
    const internal = { ...env, LLM_ALLOW_PRIVATE_ORG_ENDPOINTS: "true" };
    await ask(createGateway({ env: internal, orgOverride: org("http://10.0.0.5:8000/v1"), fetch: http.fetch, resolveHost: noDns, sleep: noSleep }));
    expect(http.requests.at(-1)!.url).toBe("http://10.0.0.5:8000/v1/chat/completions");
    expect(() => createGateway({ env: internal, orgOverride: org("http://u:p@10.0.0.5/v1") }).routeFor("chat")).toThrow(/credentials/);

    // The operator's own LLM_BASE_URL is never restricted (a local Ollama is legitimate).
    const local = createGateway({
      env: { LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "qwen" },
      fetch: http.fetch,
      resolveHost: noDns,
      sleep: noSleep,
    });
    await ask(local);
    expect(http.requests.at(-1)!.url).toBe("http://localhost:11434/v1/chat/completions");

    expect(isNonPublicAddress("8.8.8.8")).toBe(false);
    expect(isNonPublicAddress("2606:4700:4700::1111")).toBe(false);
    expect(isNonPublicAddress("::ffff:7f00:1")).toBe(true);
    expect(isNonPublicAddress("::ffff:5db8:d70e")).toBe(false);
    expect(isNonPublicAddress("not-an-ip")).toBe(true);
  });
});

describe("timeouts and cancellation", () => {
  test("R6.15 the per-attempt timeout grows with the output limit so long deep-mode calls are not cut off", async () => {
    const g = createGateway({ env: { LLM_PROVIDER: "fake" } });
    expect(g.attemptTimeoutMs({ maxTokens: 4_000 })).toBe(180_000);
    expect(g.attemptTimeoutMs(g.routeFor("review", "deep"))).toBe(Math.ceil((16_000 / 60) * 1000));
    expect(createGateway({ env: { LLM_PROVIDER: "fake", LLM_TIMEOUT_MS: "600000" } }).attemptTimeoutMs({ maxTokens: 16_000 })).toBe(600_000);
    expect(createGateway({ env: { LLM_PROVIDER: "fake", LLM_MIN_OUTPUT_TOKENS_PER_SEC: "0" } }).attemptTimeoutMs({ maxTokens: 16_000 })).toBe(180_000);

    // The SDK request carries the same timeout, so the transport does not give up first.
    const seen: (AnthropicRequestOptions | undefined)[] = [];
    const messages: AnthropicMessagesApi = {
      create: async (_body, options) => {
        seen.push(options);
        return anthropicMessage({ text: "done" });
      },
      parse: async () => Promise.reject(new Error("unused")),
    };
    const a = createGateway({ env: { LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-test-key-0000000000" }, anthropic: messages, sleep: noSleep });
    await a.text({ system: "s", prompt: "p", task: "review", mode: "deep" });
    await a.text({ system: "s", prompt: "p", task: "classify" });
    expect(seen.map((o) => o?.timeout)).toEqual([266_667, 180_000]);
  });

  test("R6.15 cancelling during a retry backoff ends the call at once", async () => {
    const provider = scriptedProvider(() => new LlmError("overloaded", { status: 529, retryable: true, retryAfterMs: 120_000 }));
    const recorder = new InMemoryModelCallRecorder();
    let sleptFor = 0;
    const g = createGateway({
      env: { LLM_PROVIDER: "fake" },
      provider,
      recorder,
      // A backoff wait that would never end on its own.
      sleep: (ms) => {
        sleptFor = ms;
        return new Promise(() => undefined);
      },
    });
    const controller = new AbortController();
    const pending = g.text({ system: "s", prompt: "p", signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(sleptFor).toBe(120_000));
    controller.abort();
    expect(await pending).toBeInstanceOf(LlmAbortError);
    expect(provider.calls).toHaveLength(1);
    expect(recorder.calls.at(-1)).toMatchObject({ status: "error", attempts: 1 });
  });
});
