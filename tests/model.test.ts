import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { HttpModel, ModelFailure } from "../src/engine/model";
import { Embeddings } from "../src/engine/embeddings";
import { classifyChanges } from "../src/engine/classify";
import { reviewSummarySchema } from "../src/engine/review";

test("OpenAI-style adapter validates responses and persistent cache avoids another request", async (t) => {
  let calls = 0;
  const cache = new Map<string, string>();
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      calls++;
      const body = JSON.parse(options.body as string);
      assert.equal(body.response_format.type, "json_object");
      assert.ok(body.messages[0].content.includes("untrusted"));
      return Response.json({
        choices: [{ message: { content: '{"answer":"verified"}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });
    },
  );
  const settings = {
    provider: "openai" as const,
    apiKey: "test-only-key",
    model: "fixture-model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
  };
  const persistence = {
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const request = {
    task: "verify",
    system: "Verify source",
    input: { sha: "1" },
  };
  const response = await new HttpModel(settings, persistence).generate(
    request,
    z.object({ answer: z.string() }),
  );
  assert.equal(response.value.answer, "verified");
  assert.equal(response.usage.estimatedCost, 0.00004);
  const cached = await new HttpModel(settings, persistence).generate(
    request,
    z.object({ answer: z.string() }),
  );
  assert.equal(calls, 1);
  assert.equal(cached.usage.cached, true);
  assert.equal(cached.usage.estimatedCost, 0);
  await new HttpModel(settings, persistence).generate(
    { ...request, input: { sha: "2" } },
    z.object({ answer: z.string() }),
  );
  assert.equal(calls, 2);
});
test("Anthropic adapter uses native Messages API and rejects invalid structured output", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      const headers = options.headers as Record<string, string>;
      assert.equal(headers["anthropic-version"], "2023-06-01");
      return Response.json({
        content: [{ type: "text", text: '{"answer":42}' }],
        usage: { input_tokens: 12, output_tokens: 2 },
      });
    },
  );
  await assert.rejects(
    new HttpModel({
      provider: "anthropic",
      apiKey: "fixture-key",
      model: "fixture",
    }).generate(
      { task: "verify", system: "", input: {} },
      z.object({ answer: z.string() }),
    ),
    (error:unknown)=>error instanceof ModelFailure && error.usage.inputTokens===36 && error.usage.outputTokens===6,
  );
});
test("semantic embedding adapter checks dimensions and restores provider ordering", async (t) => {
  const previous = process.env.EMBEDDING_MODEL;
  process.env.EMBEDDING_MODEL = "fixture-embedding";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        { index: 1, embedding: Array(1536).fill(2) },
        { index: 0, embedding: Array(1536).fill(1) },
      ],
      usage: { total_tokens: 20 },
    }),
  );
  try {
    const result = await new Embeddings().embed(["a", "b"]);
    assert.equal(result.vectors[0][0], 1);
    assert.equal(result.tokens, 20);
  } finally {
    if (previous) process.env.EMBEDDING_MODEL = previous;
    else delete process.env.EMBEDDING_MODEL;
  }
});
test("classification identifies subsystem and concrete risk areas", () => {
  const result = classifyChanges([
    {
      path: "src/auth/route.ts",
      status: "modified",
      patch: "+export async function deleteUser() {}",
    },
  ]);
  assert.deepEqual(result.subsystems, ["src/auth"]);
  assert.ok(
    result.riskAreas.includes("security") &&
      result.riskAreas.includes("data") &&
      result.riskAreas.includes("compatibility"),
  );
});

test("invalid structured output is corrected with bounded retries and all returned token usage is counted", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    calls++;
    if (calls === 2) assert.match(body.messages[0].content, /previous response failed validation/);
    return Response.json({ choices: [{ message: { content: calls === 1 ? '{"answer":42}' : '{"answer":"valid"}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  });
  const result = await new HttpModel({ provider: "openai", apiKey: "test-only-key", model: "fixture", inputCostPerMillion: 1, outputCostPerMillion: 2 }).generate({ task: "verify", system: "Return an answer string", input: {} }, z.object({ answer: z.string() }));
  assert.equal(calls, 2);
  assert.equal(result.value.answer, "valid");
  assert.equal(result.usage.inputTokens, 40);
  assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.usage.estimatedCost, 0.00008);
});
test("a passing summary contradicting failed runtime evidence is repaired before caching",async(t)=>{
  let calls=0;
  t.mock.method(globalThis,"fetch",async(_url:string,options:RequestInit)=>{
    const body=JSON.parse(options.body as string);calls++;
    if(calls===2)assert.match(body.messages[0].content,/Recorded command outcome is failed/);
    return Response.json({choices:[{message:{content:JSON.stringify({summary:calls===1?"The recorded test suite passed all regression checks.":"The recorded test suite failed; test source adds a regression case."})}}],usage:{prompt_tokens:20,completion_tokens:10}});
  });
  const schema=reviewSummarySchema({headSha:"a".repeat(40),image:"node@sha256:"+"b".repeat(64),command:"npm test",exitCode:1,timedOut:false,executionStarted:true,output:"",outputTruncated:false,network:"none",memoryMb:512,cpus:1});
  const model=new HttpModel({provider:"openai",apiKey:"fixture",model:"fixture"}),request={task:"summary",system:"Describe the recorded command outcome",input:{}};
  const result=await model.generate(request,schema);
  assert.match(result.value.summary,/test suite failed/);assert.equal(calls,2);assert.equal(result.usage.inputTokens,40);
  const cached=await model.generate(request,schema);assert.equal(cached.value.summary,result.value.summary);assert.equal(cached.usage.cached,true);assert.equal(calls,2);
});

test("billed OpenAI refusals without text retain usage across retries", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({choices:[{message:{content:null,refusal:"Unavailable"}}],usage:{prompt_tokens:11,completion_tokens:7}});
  });
  await assert.rejects(new HttpModel({provider:"openai",apiKey:"fixture",model:"fixture",inputCostPerMillion:1,outputCostPerMillion:2}).generate({task:"verify",system:"",input:{}},z.object({answer:z.string()})),(error:unknown)=>{
    assert.ok(error instanceof ModelFailure);
    assert.equal(error.usage.inputTokens,33);
    assert.equal(error.usage.outputTokens,21);
    assert.equal(error.usage.estimatedCost,0.000075);
    return true;
  });
  assert.equal(calls,3);
});

test("Anthropic envelope failures preserve reported usage", async (t) => {
  t.mock.method(globalThis,"fetch",async()=>Response.json({usage:{input_tokens:9,output_tokens:4}}));
  await assert.rejects(new HttpModel({provider:"anthropic",apiKey:"fixture",model:"fixture"}).generate({task:"verify",system:"",input:{}},z.unknown()),(error:unknown)=>error instanceof ModelFailure&&error.usage.inputTokens===27&&error.usage.outputTokens===12);
});

test("persistent cache write failure does not repeat valid paid generation or disclose its error", async (t) => {
  let calls=0;const logs:string[]=[];
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({choices:[{message:{content:'{"answer":"valid"}'}}],usage:{prompt_tokens:20,completion_tokens:10}});});
  t.mock.method(console,"error",(message:string)=>logs.push(message));
  const model=new HttpModel({provider:"openai",apiKey:"fixture",model:"fixture",inputCostPerMillion:1,outputCostPerMillion:2},{get:async()=>null,set:async()=>{throw new Error("private cache credential");}});
  const request={task:"verify",system:"",input:{}};const schema=z.object({answer:z.string()});
  const result=await model.generate(request,schema);
  assert.equal(result.value.answer,"valid");assert.equal(result.usage.estimatedCost,0.00004);
  const cached=await model.generate(request,schema);
  assert.equal(cached.usage.cached,true);assert.equal(cached.usage.estimatedCost,0);assert.equal(calls,1);
  assert.ok(logs.some(line=>JSON.parse(line).event==="model.cache_write_failed"));
  assert.ok(logs.every(line=>!line.includes("private cache credential")));
});

test("cancellation between retries retains already billed response usage", async (t) => {
  const controller=new AbortController();let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{
    calls++;setTimeout(()=>controller.abort(),0);
    return Response.json({choices:[{message:{content:'invalid json'}}],usage:{prompt_tokens:13,completion_tokens:8}});
  });
  await assert.rejects(new HttpModel({provider:"openai",apiKey:"fixture",model:"fixture"}).generate({task:"verify",system:"",input:{},signal:controller.signal},z.unknown()),(error:unknown)=>error instanceof ModelFailure&&error.usage.inputTokens===13&&error.usage.outputTokens===8);
  assert.equal(calls,1);
});
