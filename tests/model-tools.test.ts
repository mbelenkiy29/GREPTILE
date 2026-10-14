import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { HttpModel, ModelFailure, modelFromEnvironment, configuredModel, reasoningModel } from "../src/engine/model";
import { structuredSchema } from "../src/engine/json-schema";
import { inferencePrice, inferenceMicros, reservationMicros, knownPrice, priceOverrides, type InferenceBilling } from "../src/inference-billing";
import type { ToolMessage } from "../src/engine/types";

const tools = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "report_finding", description: "Report", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
];
const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void> | void) => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { await run(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

test("Anthropic tool calling replays thinking verbatim, places cache breakpoints and normalizes cache usage", async t => {
  const bodies: Record<string, unknown>[] = [];
  const thinking = { type: "thinking", thinking: "Check the caller.", signature: "sig-opaque" };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const body = JSON.parse(options.body as string);
    bodies.push(body);
    return bodies.length === 1
      ? Response.json({ content: [thinking, { type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }], stop_reason: "tool_use", usage: { input_tokens: 10, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 20 } })
      : Response.json({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 15, cache_creation_input_tokens: 40, cache_read_input_tokens: 900, output_tokens: 5 } });
  });
  const model = new HttpModel({ provider: "anthropic", apiKey: "fixture-key", model: "claude-sonnet-5-5" });
  const messages: ToolMessage[] = [{ role: "user", content: "Investigate the change." }];
  const first = await model.runTools({ task: "agent", system: "Review.", context: { diff: "shared" }, messages, tools });
  assert.equal(first.stopReason, "tool_use");
  assert.deepEqual(first.toolCalls, [{ id: "toolu_1", name: "read_file", input: { path: "a.ts" } }]);
  assert.equal(first.usage.inputTokens, 910);
  assert.equal(first.usage.cacheWriteTokens, 900);
  // Sonnet 5.5: 10×$2 + 900×$2.5 + 20×$10 per million
  assert.equal(first.usage.estimatedCost, (10 * 2 + 900 * 2.5 + 20 * 10) / 1e6);
  const b1 = bodies[0] as { system: { text: string }[]; tools: Record<string, unknown>[]; messages: { content: Record<string, unknown>[] }[] };
  assert.match(b1.system[0].text, /untrusted data/);
  assert.deepEqual(b1.tools[1].cache_control, { type: "ephemeral" });
  assert.equal(b1.tools[0].cache_control, undefined);
  assert.equal(b1.messages[0].content[0].text, JSON.stringify({ diff: "shared" }));
  assert.deepEqual(b1.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(b1.messages[0].content[1].cache_control, { type: "ephemeral" });
  messages.push(first.message, { role: "tool", results: [{ id: "toolu_1", content: "export const a = 1;" }] });
  const second = await model.runTools({ task: "agent", system: "Review.", context: { diff: "shared" }, messages, tools });
  assert.equal(second.stopReason, "end_turn");
  assert.equal(second.content, "Done.");
  assert.equal(second.usage.cacheReadTokens, 900);
  const b2 = bodies[1] as { messages: { role: string; content: Record<string, unknown>[] }[] };
  assert.deepEqual(b2.messages[1].content[0], thinking);
  assert.equal(b2.messages[1].content.length, 3);
  assert.deepEqual(b2.messages[2].content[0], { type: "tool_result", tool_use_id: "toolu_1", content: "export const a = 1;", cache_control: { type: "ephemeral" } });
  // Only the moving breakpoint moved: the first user turn no longer carries its final-block marker.
  assert.equal(b2.messages[0].content[1].cache_control, undefined);
  const breakpoints = JSON.stringify(bodies[1]).match(/"cache_control"/g) ?? [];
  assert.ok(breakpoints.length <= 4);
  assert.equal((messages[1] as { providerContent: Record<string, unknown>[] }).providerContent[0].cache_control, undefined);
});

test("OpenAI-compatible tool calling round-trips function calls and tolerates invalid argument JSON", async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(options.body as string));
    return bodies.length === 1
      ? Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }, { id: "call_2", type: "function", function: { name: "report_finding", arguments: "{not json" } }] } }], usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 64 } } })
      : Response.json({ choices: [{ finish_reason: "stop", message: { content: "No defects." } }], usage: { prompt_tokens: 150, completion_tokens: 4 } });
  });
  const model = new HttpModel({ provider: "openai", apiKey: "fixture", model: "gpt-4.1" });
  const messages: ToolMessage[] = [{ role: "user", content: "Investigate." }];
  const first = await model.runTools({ task: "agent", system: "Review.", messages, tools });
  assert.equal(first.stopReason, "tool_use");
  assert.deepEqual(first.toolCalls[0], { id: "call_1", name: "read_file", input: { path: "a.ts" } });
  assert.equal(first.toolCalls[1].input, undefined);
  assert.equal(first.usage.cacheReadTokens, 64);
  assert.equal(first.usage.estimatedCost, (36 * 2 + 64 * 0.5 + 9 * 8) / 1e6);
  const b1 = bodies[0] as { tools: { type: string; function: { name: string; parameters: unknown } }[]; max_tokens: number };
  assert.equal(b1.tools[0].type, "function");
  assert.deepEqual(b1.tools[0].function.parameters, tools[0].inputSchema);
  assert.equal(b1.max_tokens, 6000);
  messages.push(first.message, { role: "tool", results: [{ id: "call_1", content: "source" }, { id: "call_2", content: "Invalid arguments", isError: true }] });
  const second = await model.runTools({ task: "agent", system: "Review.", messages, tools });
  assert.equal(second.content, "No defects.");
  const b2 = bodies[1] as { messages: Record<string, unknown>[] };
  assert.equal(b2.messages[2].role, "assistant");
  assert.deepEqual((b2.messages[2].tool_calls as { function: { arguments: string } }[])[0].function.arguments, "{\"path\":\"a.ts\"}");
  assert.deepEqual(b2.messages.slice(3), [{ role: "tool", tool_call_id: "call_1", content: "source" }, { role: "tool", tool_call_id: "call_2", content: "Error: Invalid arguments" }]);
});

test("tool definitions are validated and failed tool turns retain billed usage", async t => {
  const model = new HttpModel({ provider: "openai", apiKey: "fixture", model: "gpt-4.1" });
  await assert.rejects(model.runTools({ task: "agent", system: "", messages: [{ role: "user", content: "x" }], tools: [{ ...tools[0], name: "bad name" }] }), /Tool names/);
  await assert.rejects(model.runTools({ task: "agent", system: "", messages: [{ role: "user", content: "x" }], tools: [tools[0], tools[0]] }), /unique/);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ usage: { prompt_tokens: 5, completion_tokens: 2 } }); });
  await assert.rejects(model.runTools({ task: "agent", system: "", messages: [{ role: "user", content: "x" }], tools }), (e: unknown) => e instanceof ModelFailure && e.usage.inputTokens === 15 && e.usage.outputTokens === 6);
  assert.equal(calls, 3);
});

test("native structured output: Anthropic output_config strips unsupported bounds, OpenAI uses json_schema, and a 400 falls back once", async t => {
  const schema = z.object({ title: z.string().min(5).max(20), score: z.number().int().min(0).max(5), tags: z.array(z.string()).max(3), note: z.string().optional() });
  const anthropicSchema = structuredSchema(schema, "anthropic")!;
  assert.equal(anthropicSchema.additionalProperties, false);
  assert.deepEqual(anthropicSchema.required, ["title", "score", "tags"]);
  const props = anthropicSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.title.minLength, undefined);
  assert.equal(props.score.maximum, undefined);
  assert.equal(props.tags.maxItems, undefined);
  assert.equal((structuredSchema(schema, "openai")!.properties as Record<string, Record<string, unknown>>).title.maxLength, 20);
  assert.equal(structuredSchema(z.unknown(), "anthropic"), undefined);
  assert.equal(structuredSchema(z.object({ meta: z.record(z.string()) }), "anthropic"), undefined);
  assert.ok(structuredSchema(z.object({ a: z.string() }).superRefine(() => {}), "anthropic"));
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    bodies.push(body);
    if (bodies.length === 1) return new Response("{\"error\":\"schema unsupported\"}", { status: 400 });
    return Response.json({ content: [{ type: "text", text: "{\"title\":\"Valid title\",\"score\":3,\"tags\":[]}" }], usage: { input_tokens: 10, output_tokens: 5 } });
  });
  const result = await new HttpModel({ provider: "anthropic", apiKey: "fixture", model: "claude-sonnet-5-5" }).generate({ task: "verify", system: "Return a title", input: {} }, schema);
  assert.equal(result.value.title, "Valid title");
  assert.ok((bodies[0].output_config as { format: { type: string } }).format.type === "json_schema");
  assert.equal(bodies[1].output_config, undefined);
  assert.equal(bodies.length, 2);
});

test("shared context is a cacheable prefix and validation repairs keep that prefix byte-identical", async t => {
  const anthropicBodies: { messages: { content: Record<string, unknown>[] }[] }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    anthropicBodies.push(JSON.parse(options.body as string));
    return Response.json({ content: [{ type: "text", text: anthropicBodies.length === 1 ? "{\"answer\":1}" : "{\"answer\":\"ok\"}" }], usage: { input_tokens: 3, cache_read_input_tokens: 2000, output_tokens: 4 } });
  });
  const request = { task: "review:security", system: "Shared reviewer system", context: { files: ["a.ts"] }, input: { assignment: { category: "security" } } };
  const result = await new HttpModel({ provider: "anthropic", apiKey: "fixture", model: "claude-sonnet-5-5" }).generate(request, z.object({ answer: z.string() }));
  assert.equal(result.usage.cacheReadTokens, 4000);
  const [first, second] = anthropicBodies;
  assert.deepEqual(first.messages[0].content[0], { type: "text", text: JSON.stringify(request.context), cache_control: { type: "ephemeral" } });
  assert.deepEqual(second.messages[0].content[0], first.messages[0].content[0]);
  assert.deepEqual((second as unknown as { system: unknown }).system, (first as unknown as { system: unknown }).system);
  assert.match(String(second.messages[0].content[2].text), /previous response failed validation/);
  const openaiBodies: { messages: { role: string; content: string }[] }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    openaiBodies.push(JSON.parse(options.body as string));
    return Response.json({ choices: [{ message: { content: "{\"answer\":\"ok\"}" } }], usage: { prompt_tokens: 20, completion_tokens: 3 } });
  });
  await new HttpModel({ provider: "compatible", baseUrl: "https://models.example/v1", apiKey: "", model: "fixture" }).generate(request, z.object({ answer: z.string() }));
  assert.deepEqual(openaiBodies[0].messages.map(m => m.role), ["system", "user", "user"]);
  assert.equal(openaiBodies[0].messages[1].content, JSON.stringify(request.context));
});

test("reasoning models use max_completion_tokens with a larger default; output limits are configurable per task", async t => {
  assert.ok(reasoningModel("o3") && reasoningModel("gpt-5.1") && reasoningModel("openai/o4-mini") && !reasoningModel("gpt-4.1"));
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(options.body as string));
    return Response.json({ choices: [{ message: { content: "{\"answer\":\"ok\"}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  await new HttpModel({ provider: "openai", apiKey: "k", model: "o3" }).generate({ task: "verify", system: "", input: { a: 1 } }, z.object({ answer: z.string() }));
  assert.equal(bodies[0].max_completion_tokens, 16000);
  assert.equal(bodies[0].max_tokens, undefined);
  await withEnv({ LLM_MAX_OUTPUT_TOKENS_VERIFY: "9000" }, async () => {
    await new HttpModel({ provider: "openai", apiKey: "k", model: "gpt-4.1" }).generate({ task: "verify", system: "", input: { a: 2 } }, z.object({ answer: z.string() }));
  });
  assert.equal(bodies[1].max_tokens, 9000);
  await withEnv({ LLM_MAX_OUTPUT_TOKENS_VERIFY: "12" }, async () => {
    await assert.rejects(new HttpModel({ provider: "openai", apiKey: "k", model: "gpt-4.1" }).generate({ task: "verify", system: "", input: { a: 3 } }, z.object({ answer: z.string() })), /between 256 and 128000/);
  });
  await withEnv({ LLM_PROVIDER: "openai", LLM_MAX_OUTPUT_TOKENS: "abc", LLM_MODEL: undefined }, () => {
    assert.throws(() => modelFromEnvironment(), /LLM_MAX_OUTPUT_TOKENS/);
  });
});

test("Anthropic provider defaults to current Claude models per task while explicit models win", async () => {
  await withEnv({ LLM_PROVIDER: "anthropic", LLM_MODEL: undefined, LLM_MODEL_SUMMARY: undefined, LLM_MODEL_REVIEW: undefined, LLM_MODEL_KNOWLEDGE: undefined }, async () => {
    assert.equal(configuredModel("review:security"), "claude-sonnet-5-5");
    assert.equal(configuredModel("conversation"), "claude-sonnet-5-5");
    assert.equal(configuredModel("summary"), "claude-haiku-5-5");
    assert.equal(configuredModel("knowledge"), "claude-haiku-5-5");
    assert.equal(configuredModel("summary", "claude-opus-5-5"), "claude-opus-5-5");
    process.env.LLM_MODEL_SUMMARY = "claude-sonnet-5-5";
    assert.equal(configuredModel("summary"), "claude-sonnet-5-5");
  });
  await withEnv({ LLM_PROVIDER: undefined, LLM_MODEL: undefined, LLM_MODEL_REVIEW: undefined }, () => assert.equal(configuredModel("review:data"), "gpt-4.1"));
});

test("price table: verified built-ins, long-prompt tiers, cache-aware accounting, operator overrides and fail-closed defaults", async () => {
  const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5", baseUrl: "https://api.anthropic.com/v1", inputTokenCeiling: 1000, outputTokenCeiling: 100 };
  assert.deepEqual(inferencePrice(sonnet), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  assert.equal(reservationMicros(1000, 100, inferencePrice(sonnet)), 1000 * 2.5 + 100 * 10);
  assert.equal(inferenceMicros(1000, 100, inferencePrice(sonnet), { read: 800, write: 100 }), Math.ceil(100 * 2 + 800 * 0.1 + 100 * 2.5 + 100 * 10));
  assert.throws(() => inferenceMicros(10, 1, inferencePrice(sonnet), { read: 8, write: 8 }), /Invalid/);
  assert.equal(inferencePrice({ ...sonnet, model: "claude-haiku-5-5", inputTokenCeiling: 90_000 }).input, 0.1);
  assert.equal(inferencePrice({ ...sonnet, model: "claude-haiku-5-5", inputTokenCeiling: 150_000 }).input, 0.5);
  assert.throws(() => inferencePrice({ ...sonnet, model: "claude-unknown-9" }), /no verified price for this model/);
  assert.throws(() => inferencePrice({ ...sonnet, baseUrl: "https://proxy.example/v1" }), /no verified price for this endpoint/);
  assert.throws(() => inferencePrice({ ...sonnet, provider: "compatible", baseUrl: "https://models.example/v1", model: "local" }), /endpoint/);
  assert.deepEqual(inferencePrice({ provider: "openai", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1/", inputTokenCeiling: 1, outputTokenCeiling: 1 }), { input: 2, output: 8, cacheRead: 0.5, cacheWrite: undefined });
  await withEnv({ INFERENCE_PRICES: JSON.stringify({ "compatible:local": { input: 0.5, output: 1, baseUrl: "https://models.example/v1/" } }) }, () => {
    assert.deepEqual(inferencePrice({ provider: "compatible", model: "local", baseUrl: "https://models.example/v1", inputTokenCeiling: 1, outputTokenCeiling: 1 }), { input: 0.5, output: 1, baseUrl: "https://models.example/v1" });
    assert.throws(() => inferencePrice({ provider: "compatible", model: "local", baseUrl: "https://other.example/v1", inputTokenCeiling: 1, outputTokenCeiling: 1 }), /endpoint/);
  });
  for (const bad of ["[]", "{", JSON.stringify({ "openai:x": { input: -1, output: 1 } }), JSON.stringify({ "openai:x": { input: 1 } })]) assert.throws(() => priceOverrides(bad), /INFERENCE_PRICES/);
  await withEnv({ INFERENCE_PRICES: "{bad" }, () => {
    assert.throws(() => inferencePrice(sonnet), /INFERENCE_PRICES/);
    assert.equal(knownPrice("anthropic", "claude-sonnet-5-5", "https://api.anthropic.com/v1"), undefined);
  });
});

test("budget receipts carry cache token counts so cached prompts settle at their real price", async t => {
  const receipts: unknown[] = [];
  const billing: InferenceBilling = { async reserve(q) { assert.equal(q.outputTokenCeiling, 16000); return "r"; }, async settle(_id, u) { receipts.push(u); } };
  t.mock.method(globalThis, "fetch", async () => Response.json({ content: [{ type: "text", text: "{\"answer\":\"ok\"}" }], usage: { input_tokens: 5, cache_read_input_tokens: 700, cache_creation_input_tokens: 30, output_tokens: 6 } }));
  await new HttpModel({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5-5" }, undefined, billing).generate({ task: "verify", system: "", input: {} }, z.object({ answer: z.string() }));
  assert.deepEqual(receipts, [{ inputTokens: 735, outputTokens: 6, cacheReadTokens: 700, cacheWriteTokens: 30 }]);
});
