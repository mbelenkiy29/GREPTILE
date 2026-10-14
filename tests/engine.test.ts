import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { findingComment } from "../src/github";
import {reviewSummary} from "../src/review-summary";
import {summarySections} from "../src/review-settings";
import {
  changedLines,
  parseDiff,
  fingerprint,
  overlaps,
} from "../src/engine/diff";
import { eligibleFile, indexRepository, moduleReferencesCurrent, redact } from "../src/engine/indexer";
import { retrieve } from "../src/engine/retrieval";
import { grounded, reviewChange, reviewSummarySchema, resolutionSchema } from "../src/engine/review";
import { validateModelUrl, HttpModel } from "../src/engine/model";
import { sourceChunks } from "../src/engine/chunks";
import type {
  Candidate,
  ModelProvider,
  ModelRequest,
  ReviewInput,
} from "../src/engine/types";

export const candidate: Candidate = {
  title: "Deleted accounts remain authorized",
  description:
    "The caller treats undefined as an active account, allowing deleted users to access the organization.",
  severity: "high",
  confidence: 0.97,
  category: "security",
  filePath: "auth.ts",
  startLine: 2,
  endLine: 2,
  evidence: [
    {
      filePath: "auth.ts",
      startLine: 2,
      quote: "  return user?.active !== false;",
    },
    {
      filePath: "route.ts",
      startLine: 2,
      quote:
        "export function route(user) { if (allowed(user)) return secret; }",
    },
  ],
  impact: "Deleted users retain organization access.",
  suggestedFix: "Require a present user and active === true.",
  symbol: "allowed",
};
export const input: ReviewInput = {
  repository: "fixture/cross-file",
  baseSha: "base",
  headSha: "head",
  title: "Handle missing accounts",
  description: "",
  files: [
    {
      path: "auth.ts",
      sha: "1",
      content:
        "export function allowed(user) {\n  return user?.active !== false;\n}",
    },
    {
      path: "route.ts",
      sha: "2",
      content:
        "import { allowed } from './auth';\nexport function route(user) { if (allowed(user)) return secret; }",
    },
  ],
  diff: [
    {
      path: "auth.ts",
      status: "modified",
      patch:
        "@@ -1,3 +1,3 @@\n export function allowed(user) {\n-  return user.active;\n+  return user?.active !== false;\n }",
    },
  ],
  rules: [],
  mode: "standard",
};
class FixtureModel implements ModelProvider {
  calls: string[] = [];
  requests: ModelRequest[] = [];
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    this.calls.push(request.task);
    this.requests.push(request);
    const value = request.task.startsWith("review:")
      ? {
          findings:
            request.task === "review:security" ||
            request.task === "review:correctness"
              ? [candidate]
              : [],
        }
      : request.task === "verify"
        ? {
            decisions: [
              {
                index: 0,
                publish: true,
                reason:
                  "Missing user passes auth guard and route exposes secret.",
                confidence: 0.96,
              },
            ],
          }
        : request.task === "resolution"
          ? { resolved: [] }
          : request.task === "diagram"
            ? { diagram: null }
            // J2: model-reported security findings get one exploitability assessment.
            : request.task === "exploit"
              ? { assessments: [{ index: 0, exploitPath: true, reason: "route() returns the secret for any user the guard accepts, including a missing one." }] }
            : {
              reviewScore:{value:1,reason:"The verified defect needs correction before this change is ready to merge."},summary:
                "This change updates authentication. One high severity authorization defect was verified.",
            };
    return {
      value: schema.parse(value),
      usage: {
        task: request.task,
        provider: "fixture",
        model: "deterministic",
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 1,
        estimatedCost: 0,
        cached: false,
      },
    };
  }
}
test("specialists share one system prompt and one payload object so providers can cache the prefix", async () => {
  const model = new FixtureModel();
  await reviewChange(input, model);
  const specialists = model.requests.filter((r) => r.task.startsWith("review:"));
  assert.ok(specialists.length >= 6);
  assert.equal(new Set(specialists.map((r) => r.system)).size, 1);
  assert.equal(new Set(specialists.map((r) => JSON.stringify(r.context))).size, 1);
  assert.deepEqual(specialists.map((r) => (r.input as { assignment: { category: string } }).assignment.category), specialists.map((r) => r.task.slice("review:".length)));
  assert.ok(specialists.every((r) => !JSON.stringify(r.input).includes("auth.ts")));
});
test("candidate remediation execution claims are repaired before publication and caching", async t => {
  const unsupported = "The regression tests passed after requiring a present active user.";
  const corrected = candidate.suggestedFix + " Run the regression tests to verify authentication.";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(String(url), "https://review-model.example/v1/chat/completions");
    const body = JSON.parse(options.body as string);
    calls++;
    if (calls === 2) assert.match(body.messages[0].content, /No test execution evidence was supplied/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [{ ...candidate, suggestedFix: calls === 1 ? unsupported : corrected }] }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  });
  let persisted = JSON.stringify({ value: { findings: [{ ...candidate, suggestedFix: unsupported }] }, usage: { task: "review:security", provider: "compatible", model: "fixture", inputTokens: 10, outputTokens: 5, latencyMs: 1, estimatedCost: 0, cached: false } });
  const http = new HttpModel({ provider: "compatible", baseUrl: "https://review-model.example/v1", apiKey: "fixture-only", model: "fixture" }, { get: async () => persisted, set: async (_key, value) => { persisted = value; } });
  class RepairModel extends FixtureModel {
    override async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
      return request.task === "review:security" ? http.generate(request, schema) : super.generate(request, schema);
    }
  }
  const model = new RepairModel(), reviewInput: ReviewInput = { ...input, settings: { categories: ["security"] } };
  const result = await reviewChange(reviewInput, model);
  assert.equal(calls, 2);
  assert.equal(result.findings[0].suggestedFix, corrected);
  assert.equal(findingComment(result.findings[0]).includes(unsupported), false);
  assert.equal(result.usage.find(u => u.task === "review:security")?.inputTokens, 40);
  assert.equal(result.usage.find(u => u.task === "review:security")?.outputTokens, 20);
  assert.equal(JSON.parse(persisted).value.findings[0].suggestedFix, corrected);
  const cached = await reviewChange(reviewInput, model);
  assert.equal(calls, 2);
  assert.equal(cached.usage.find(u => u.task === "review:security")?.cached, true);
  assert.equal(cached.findings[0].suggestedFix, corrected);
});
test("diff line coordinates account for additions, removals and multiple hunks", () => {
  assert.deepEqual(
    [
      ...changedLines(
        "@@ -2,3 +2,3 @@\n same\n-old\n+new\n same\n@@ -20 +20,2 @@\n+x\n+y",
      ),
    ],
    [3, 20, 21],
  );
  assert.equal(
    parseDiff(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b",
    )[0].path,
    "a.ts",
  );
});
test("fingerprints tolerate whitespace and line movement", () => {
  const moved = {
    ...candidate,
    startLine: 8,
    endLine: 8,
    evidence: candidate.evidence.map((e) => ({
      ...e,
      quote: e.quote.replace(/ /g, ""),
    })),
  };
  assert.equal(fingerprint(candidate), fingerprint(moved));
  assert.ok(overlaps(candidate, moved));
});
test("index excludes ignored and secret files and extracts cross-file imports", () => {
  assert.equal(
    eligibleFile({ path: ".env.local", sha: "", content: "secret" }),
    false,
  );
  assert.equal(
    eligibleFile(
      { path: "generated/x.ts", sha: "", content: "x" },
      "generated/",
    ),
    false,
  );
  assert.equal(redact("token=ghp_" + "x".repeat(30)).includes("ghp_"), false);
  const index = indexRepository(input.files);
  assert.ok(index.symbols.some((s) => s.name === "allowed"));
  assert.ok(
    index.relationships.some(
      (r) => r.from === "route.ts" && r.to === "auth.ts",
    ),
  );
});
test("retrieval includes external callers and obeys budget", () => {
  const result = retrieve(indexRepository(input.files), input.diff, 1000);
  assert.ok(
    result.some((c) => c.path === "route.ts" && c.reason.includes("caller")),
  );
  assert.ok(result.reduce((sum, c) => sum + c.content.length, 0) <= 4000);
});
test("module graph connects re-exports, CommonJS and literal dynamic imports to source files", () => {
  const index=indexRepository([
    {path:"src/value.ts",sha:"x",content:"export const result = 7;"},
    {path:"src/barrel.ts",sha:"x",content:"export { result } from './value.js';"},
    {path:"tests/value.test.cts",sha:"x",content:"const subject = require('../src/value.js');"},
    {path:"load.mts",sha:"x",content:"export const later = () => import('./src/value.js');"},
    {path:"legacy.cts",sha:"x",content:"import subject = require('./src/value.js');"},
    {path:"computed.ts",sha:"x",content:"const x = require(target); const y = import(target);"},
  ]);
  for(const [from,kind] of [["src/barrel.ts","exports"],["tests/value.test.cts","imports"],["load.mts","imports"],["legacy.cts","imports"]])
    assert.ok(index.relationships.some(r=>r.from===from&&r.to==="src/value.ts"&&r.kind===kind),`${from} has a resolved ${kind} edge`);
  assert.ok(index.relationships.some(r=>r.from==="src/value.ts"&&r.to==="tests/value.test.cts"&&r.kind==="tested-by"));
  assert.equal(index.relationships.some(r=>r.from==="computed.ts"&&r.kind==="imports"),false);
  assert.equal(index.moduleReferences?.length,4);
  for(const reference of index.moduleReferences??[])assert.equal(reference.resolvedPath,"src/value.ts");
  const context=retrieve(index,[{path:"src/value.ts",status:"modified",patch:"@@ -1 +1 @@\n-old\n+new"}],2000);
  for(const name of ["src/barrel.ts","tests/value.test.cts","load.mts","legacy.cts"])
    assert.ok(context.some(c=>c.path===name&&c.reason.includes("dependency/caller/test")),`${name} is retrieved through the graph`);
});
test("module receipts detect target inventory changes without invalidating unrelated files",()=>{
  const references=[{specifier:"./value.js",resolvedPath:"src/value.ts"}];
  assert.equal(moduleReferencesCurrent("src/consumer.ts",undefined,new Set()),false);
  assert.equal(moduleReferencesCurrent("src/consumer.ts",[],new Set(["elsewhere.ts"])),true);
  assert.equal(moduleReferencesCurrent("src/consumer.ts",references,new Set(["src/value.ts","elsewhere.ts"])),true);
  assert.equal(moduleReferencesCurrent("src/consumer.ts",references,new Set(["src/value.ts","src/value.js"])),false);
  assert.equal(moduleReferencesCurrent("src/consumer.ts",references,new Set()),false);
});
test("module resolution preserves explicit files, native module extensions, packages and known incremental paths",()=>{
  const index=indexRepository([{path:"consumer.ts",sha:"x",content:"import './direct.js'; import './module.mjs'; import './common.cjs'; import './directory'; import './directory.v2'; import 'node:fs'; import './absent';"}],
    ["direct.js","direct.ts","module.mts","common.cts","directory/index.mjs","directory.v2/index.cts"]);
  assert.deepEqual(index.relationships.filter(r=>r.kind==="imports").map(r=>r.to),["direct.js","module.mts","common.cts","directory/index.mjs","directory.v2/index.cts","node:fs","absent"]);
});
test("semantic hints retain related code without literal symbol overlap and searchable chunks keep line numbers", () => {
  const index = indexRepository([
    { path: "unrelated.ts", sha: "x", content: "const elephant = 42;" },
  ]);
  const context = retrieve(index, input.diff, 1000, [
    { path: "unrelated.ts", reason: "semantic embedding match", score: 35 },
  ]);
  assert.equal(context[0].reason, "semantic embedding match");
  const chunks = sourceChunks("first\nsecond\nthird", 12);
  assert.deepEqual(
    chunks.map((c) => c.startLine),
    [1, 2, 3],
  );
  assert.ok(chunks.every((c) => c.content.length <= 12));
});
test("evidence and changed-line validation rejects hallucinations", () => {
  assert.ok(grounded(candidate, input));
  assert.equal(grounded({ ...candidate, startLine: 1 }, input), false);
  assert.equal(
    grounded(
      {
        ...candidate,
        evidence: [{ filePath: "auth.ts", startLine: 2, quote: "invented" }],
      },
      input,
    ),
    false,
  );
});
test("model URL rejects accidental private endpoints and credentials", () => {
  assert.throws(() => validateModelUrl("http://169.254.169.254"));
  assert.throws(() => validateModelUrl("https://user:pass@example.com"));
  assert.throws(() => validateModelUrl("https://localhost"));
  assert.equal(
    validateModelUrl("http://localhost:11434/v1", true).hostname,
    "localhost",
  );
});
test("shared pipeline runs specialties, verifies, deduplicates, persists usage and suppresses existing issues", async () => {
  const model = new FixtureModel();
  const stages: string[] = [];
  const result = await reviewChange(input, model, async (stage) => {
    stages.push(stage);
  });
  assert.equal(result.findings.length, 1);
  const numbered=model.requests.find(r=>r.task==="review:security")!.context as {context:{path:string;content:string}[];diff:{changedLineNumbers:number[]}[]};
  assert.ok(numbered.context.find(c=>c.path==="auth.ts")!.content.includes("2:   return user?.active !== false;"));
  assert.deepEqual(numbered.diff[0].changedLineNumbers,[2]);
  assert.equal(result.findings[0].evidence[0].quote,"  return user?.active !== false;");
  assert.ok(
    model.calls.includes("review:security") &&
      model.calls.includes("review:data"),
  );
  assert.ok(model.calls.includes("verify"));
  assert.ok(result.metadata.context.some((c) => c.path === "route.ts"));
  assert.equal(result.usage.length, model.calls.length);
  assert.deepEqual(stages, [
    "retrieving_context",
    "reviewing",
    "verifying",
    "summarizing",
  ]);
  const second = await reviewChange(
    { ...input, existingFindings: result.findings },
    new FixtureModel(),
  );
  assert.equal(second.findings.length, 0);
});
test("cancelled reviews make no model calls", async () => {
  const model = new FixtureModel();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reviewChange(input, model, undefined, controller.signal),
  );
  assert.equal(model.calls.length, 0);
});

test("confidence threshold and rule glob applicability suppress noise without truncating stored findings", async () => {
  const model = new FixtureModel();
  const rules = [
    {
      id: "auth",
      instructions: "Validate user presence",
      severity: "high" as const,
      category: "security",
      globs: ["auth.ts"],
      enabled: true,
    },
    {
      id: "other",
      instructions: "Unrelated file rule",
      severity: "high" as const,
      category: "security",
      globs: ["unrelated/**"],
      enabled: true,
    },
  ];
  const result = await reviewChange(
    { ...input, rules, settings: { minimumConfidence: 0.99 } },
    model,
  );
  assert.equal(result.findings.length, 0);
  const rulesRequest = model.requests.find((r) => r.task === "review:rules");
  assert.ok(rulesRequest);
  assert.deepEqual(
    (rulesRequest.context as { rules: { id: string }[] }).rules.map((r) => r.id),
    ["auth"],
  );
  const stored = await reviewChange(
    { ...input, settings: { maxComments: 0 } },
    new FixtureModel(),
  );
  assert.equal(
    stored.findings.length,
    1,
    "comment cap must not discard dashboard findings",
  );
});

test("runtime evidence is commit-bound, redacted, supplied to specialists and retained in results", async () => {
  const runtimeEvidence = {
    headSha: "a".repeat(40),
    image: "node@sha256:" + "b".repeat(64),
    command: "npm test",
    exitCode: 1,
    timedOut: false,
    executionStarted:true,
    output: 'password="runtime-secret-value"\nAuthorization test failed',
    outputTruncated: false,
    network: "none" as const,
    memoryMb: 512 as const,
    cpus: 1 as const,
  };
  const model = new FixtureModel();
  await assert.rejects(
    reviewChange({ ...input, runtimeEvidence }, model),
    /different commit/,
  );
  assert.equal(model.calls.length, 0);
  const result = await reviewChange(
    { ...input, headSha: runtimeEvidence.headSha, runtimeEvidence },
    model,
  );
  assert.ok(result.metadata.runtimeEvidence?.output.includes("[REDACTED]"));
  assert.ok(!JSON.stringify(model.requests).includes("runtime-secret-value"));
  assert.equal(
    (model.requests[0].context as { runtimeEvidence: { exitCode: number } })
      .runtimeEvidence.exitCode,
    1,
  );
  assert.match(result.summary,/· failed at/);
  for(const [evidence,status] of [
    [{...runtimeEvidence,exitCode:0},"passed"],
    [{...runtimeEvidence,exitCode:0,timedOut:true},"timed out"],
    [{...runtimeEvidence,exitCode:null},"outcome unavailable"],
    [{...runtimeEvidence,executionStarted:false,exitCode:0},"execution not confirmed"],
    [{...runtimeEvidence,executionStarted:undefined,exitCode:0},"execution not confirmed"],
  ] as const){
    const review=await reviewChange({...input,headSha:evidence.headSha,runtimeEvidence:evidence},new FixtureModel());
    assert.ok(review.summary.includes(`· ${status} at`));
  }
});

test("summary outcomes must match recorded execution rather than command startup",()=>{
  const evidence:NonNullable<ReviewInput["runtimeEvidence"]>={headSha:"a".repeat(40),image:"node@sha256:"+"b".repeat(64),command:"npm test",exitCode:0,timedOut:false,executionStarted:true,output:"",outputTruncated:false,network:"none",memoryMb:512,cpus:1};
  const success=["The recorded test suite passed with all regression checks.","All tests are **green** in the recorded run.","The recorded command completed successfully.","The regression checks verify the corrected behavior."];
  for(const summary of success){
    assert.equal(reviewSummarySchema(evidence).safeParse({summary}).success,true,summary);
    for(const runtime of [undefined,{...evidence,exitCode:1},{...evidence,exitCode:null},{...evidence,timedOut:true},{...evidence,executionStarted:false},{...evidence,executionStarted:undefined}])
      assert.equal(reviewSummarySchema(runtime).safeParse({summary}).success,false,summary);
  }
  for(const [runtime,summary] of [
    [{...evidence,exitCode:1},"The recorded test suite failed during execution."],
    [{...evidence,timedOut:true},"The recorded test suite timed out during execution."],
    [{...evidence,exitCode:null},"We ran tests but the execution outcome is unavailable."],
  ] as const){
    assert.equal(reviewSummarySchema(runtime).safeParse({summary}).success,true);
    assert.equal(reviewSummarySchema().safeParse({summary}).success,false);
  }
  assert.equal(reviewSummarySchema().safeParse({summary:"No evidence of test execution was supplied, tests passed."}).success,false);
  assert.equal(reviewSummarySchema(evidence).safeParse({summary:"The recorded test suite failed during execution."}).success,false);
  assert.equal(reviewSummarySchema(evidence).safeParse({summary:"The recorded test suite timed out during execution."}).success,false);
  assert.equal(reviewSummarySchema({...evidence,exitCode:1}).safeParse({summary:"The tests did not pass; test source adds a regression case."}).success,true);
});

test("comment style changes evidence formatting while preserving impact, remediation and identity", () => {
  const finding = {
    ...candidate,
    agent: "security",
    commitSha: "a".repeat(40),
    fingerprint: "b".repeat(64),
  };
  const detailed = findingComment(finding, "detailed"),
    concise = findingComment(finding, "concise");
  assert.ok(detailed.includes("```"));
  assert.ok(!concise.includes("```"));
  for (const body of [detailed, concise]) {
    assert.ok(body.includes(finding.impact));
    assert.ok(body.includes(finding.suggestedFix));
    assert.ok(body.includes(finding.fingerprint));
    assert.ok(body.includes("Evidence:"));
  }
});


test("resolution requires exact current source coordinates, known unique fingerprints and recorded execution",()=>{
 const previous=[{fingerprint:"native-cents"}],sources=[{path:"src/price.ts",content:"// Public contract: integer cents.\nexport function priceInCents(dollars: number): number {\n  return Math.round(dollars * 100);\n}"}];
 const proof={fingerprint:"native-cents",evidence:"Current source restores integer cents at the payment boundary.",filePath:"src/price.ts",startLine:3,quote:"  return Math.round(dollars * 100);"};
 const schema=resolutionSchema(previous,sources);
 assert.equal(schema.safeParse({resolved:[proof]}).success,true);
 for(const invalid of [{startLine:2},{quote:"return Math.round(dollars * 100)"},{filePath:"unfetched.ts"},{fingerprint:"unknown"},{evidence:"Regression tests confirm the payment gateway behavior is now correct."}])assert.equal(schema.safeParse({resolved:[{...proof,...invalid}]}).success,false);
 assert.equal(schema.safeParse({resolved:[proof,proof]}).success,false);
 assert.equal(schema.safeParse({resolved:[]}).success,true);
 assert.equal(reviewSummarySchema(undefined,undefined,undefined,true).safeParse({summary:"The previous critical finding is resolved by this source change."}).success,false);
 assert.equal(reviewSummarySchema(undefined,undefined,undefined,true).safeParse({summary:"The return statement changed. No prior finding was confirmed resolved."}).success,true);
});
test("a fix reverting the full PR diff still supplies current code for resolution", async () => {
  const previous = { ...candidate, agent: "correctness", fingerprint: fingerprint(candidate), commitSha: input.headSha };
  let assessed = false;
  const model: ModelProvider = {
    async generate(request, schema) {
      if (request.task === "resolution") {
        assessed = true;
        const payload = request.input as { context: { path: string }[] };
        assert.ok(payload.context.some((c) => c.path === previous.filePath));
      }
      if (request.task === "summary") {
        const payload = request.input as { resolvedFindings: { fingerprint: string }[] };
        assert.equal(payload.resolvedFindings[0].fingerprint, previous.fingerprint);
      }
      return { value: schema.parse(request.task === "resolution" ? { resolved: [{ fingerprint: previous.fingerprint, evidence: "Current head restores the original safe behavior.",filePath:"auth.ts",startLine:2,quote:"  return !!user && user.active === true;" }] } : request.task === "summary" ? { reviewScore:{value:1,reason:"The verified defect needs correction before this change is ready to merge."},summary: "The original behavior was restored; the previous issue is resolved." } : { findings: [] }), usage: { task: request.task, provider: "fixture", model: "fixture", inputTokens: 0, outputTokens: 0, latencyMs: 0, estimatedCost: 0, cached: false } };
    },
  };
  const result = await reviewChange({ ...input, headSha:"b".repeat(40), files:input.files.map(f=>f.path==="auth.ts"?{...f,content:"export function allowed(user) {\n  return !!user && user.active === true;\n}"}:f), diff: [], existingFindings: [previous] }, model);
  assert.equal(assessed, true);
  assert.deepEqual(result.metadata.resolvedFingerprints, [previous.fingerprint]);
});


test("specialists with different wording deduplicate the same source-backed currency defect", () => {
  const first = { ...candidate, title: "total() now returns float normalized dollars, breaking integer cents contract", impact: "Payments may be processed incorrectly by downstream systems expecting integer cents. Unit tests expecting amount 500 will fail as they receive 5. Under-charges or test suite failures." };
  const second = { ...first, category: "compatibility" as const, title: "Billing returns floating-point currency instead of integer cents", impact: "Payment amounts may be processed or displayed incorrectly by downstream consumers that expect cents. Tests will fail; deployments risk financial miscalculations." };
  assert.equal(overlaps(first, second), true);
  assert.equal(overlaps(first, { ...second, title: "Authorization permits cross-tenant access", impact: "An attacker reads another account's private data.", evidence: [{ filePath: "auth.ts", startLine: 9, quote: "return true;" }] }), false);
});
test("same-revision re-review cannot resolve a finding and carries revalidated evidence forward",async()=>{
 const previous={...candidate,agent:"security",fingerprint:fingerprint(candidate),commitSha:input.headSha};
 let resolutionCalls=0;
 const model:ModelProvider={async generate(request,schema){
  if(request.task==="resolution")resolutionCalls++;
  const value=request.task.startsWith("review:")?{findings:request.task==="review:security"?[candidate]:[]}:request.task==="verify"?{decisions:[{index:0,publish:true,confidence:.99,reason:"Exact source confirms the authorization issue."}]}:request.task==="summary"?{reviewScore:{value:1,reason:"The verified defect needs correction before this change is ready to merge."},summary:"The authorization issue remains unresolved at the current revision."}:{resolved:[]};
  return {value:schema.parse(value),usage:{task:request.task,provider:"fixture",model:"fixture",inputTokens:0,outputTokens:0,estimatedCost:0,latencyMs:0,cached:false}};
 }};
 const result=await reviewChange({...input,existingFindings:[previous]},model);
 assert.equal(resolutionCalls,0);assert.deepEqual(result.metadata.resolvedFingerprints,[]);
 assert.equal(result.metadata.carriedForward?.[0].fingerprint,previous.fingerprint);
 assert.equal(result.metadata.carriedForward?.[0].commitSha,input.headSha);
});

test("oversized source is excluded by byte size even when the provider omits content",()=>{
 assert.equal(eligibleFile({path:"src/large.ts",sha:"a",content:"",size:200001}),false);
 assert.equal(eligibleFile({path:"src/unicode.ts",sha:"b",content:"é".repeat(100001)}),false);
});

test("configurable summaries preserve evidence and validate risk prose, with one shared preview renderer",async()=>{
 const data={overview:"Updates authentication without changing the public endpoint.",files:[{path:"auth.ts",status:"modified",patch:""},{path:"tests/auth.test.ts",status:"added",patch:""}],findings:[],resolved:[],assessment:undefined,runtimeEvidence:undefined,coverageLimits:["Security category excluded"],contextCount:2,candidates:0,suppressed:0};
 const full=reviewSummary(data);
 for(const section of ["Overview","Files changed","Issues","Resolved findings","Risk assessment","Skipped files","Test source","Test execution","Coverage"])assert.ok(full.includes("### "+section));
 assert.match(full,/`tests\/auth.test.ts`/);assert.match(full,/Not executed by OpenReview/);assert.match(full,/Security category excluded/);
 const minimal=reviewSummary(data,[]);assert.match(minimal,/### Test execution/);assert.match(minimal,/### Coverage/);assert.equal(minimal.includes(data.overview),false);assert.equal(minimal.includes("### Issues"),false);
 assert.throws(()=>reviewSummary(data,["madeUp"]),/Invalid summary sections/);assert.throws(()=>reviewSummary(data,["overview","overview"]),/Invalid summary sections/);
 assert.equal(reviewSummarySchema().safeParse({summary:data.overview,approvalAssessment:{risk:"low",confidence:1,reason:"Passing regression tests establish that authorization works."}}).success,false);
 assert.equal(reviewSummarySchema(undefined,[]).safeParse({summary:data.overview,approvalAssessment:{risk:"low",confidence:1,reason:"Requirements confirmed at https://linear.app/team/issue/ENG-9/fake"}}).success,false);
 const model=new FixtureModel(),input:ReviewInput={repository:"acme/api",baseSha:"a".repeat(40),headSha:"b".repeat(40),title:"Update authentication",description:"",files:[],diff:[],rules:[],mode:"standard",settings:{summarySections:[]}};
 const review=await reviewChange(input,model);assert.equal(review.summary.includes("### Overview"),false);assert.match(review.summary,/### Test execution/);
 assert.equal(summarySections.length,10); // G5 added the "tips" footer toggle
});


test("merge readiness is recorded separately from assessment confidence and validates every published reason",async()=>{
 const score={value:1,reason:"The confirmed authorization defect blocks safe merging of this revision."};
 const approvalAssessment={risk:"high" as const,confidence:1,reason:"The changed guard and caller establish unauthenticated private data access."};
 const summary="The authentication guard permits missing users to access private data.";
 const finding={...candidate,commitSha:input.headSha,agent:"security",fingerprint:"score",severity:"critical" as const};
 const validator=reviewSummarySchema(undefined,[],[finding]);
 assert.equal(validator.safeParse({summary,approvalAssessment}).success,false);
 for(const value of [-1,1.5,6,5,2])assert.equal(validator.safeParse({summary,approvalAssessment,reviewScore:{...score,value}}).success,false);
 assert.equal(validator.parse({summary,approvalAssessment,reviewScore:score}).approvalAssessment?.confidence,1);
 assert.equal(validator.safeParse({summary,reviewScore:{...score,reason:"Regression tests passed and confirm authorization works."}}).success,false);
 assert.equal(validator.safeParse({summary,reviewScore:{...score,reason:"Requirements are confirmed at https://linear.app/acme/issue/ENG-99/invented"}}).success,false);
 assert.equal(reviewSummarySchema().parse({summary}).reviewScore,undefined);
 const result=await reviewChange(input,new FixtureModel());
 assert.equal(result.metadata.reviewScore?.value,1);assert.match(result.summary,/### Confidence score\n\*\*1\/5\*\* — /);
 assert.equal(reviewSummary({overview:summary,score:result.metadata.reviewScore,files:[],findings:[],resolved:[],assessment:approvalAssessment,runtimeEvidence:undefined,coverageLimits:[],contextCount:0,candidates:0,suppressed:0},["risk"]).includes("### Confidence score"),false);
});

test("structured summaries reject malformed control characters while preserving readable Markdown",()=>{
 const summary="Changes the parameterized SQL query to unsafe interpolation.";
 for(const control of ['\u0000','\u0007','\u000b','\u001b','\u007f']){
  for(const value of [{summary:summary+control},{summary,reviewScore:{value:1,reason:summary+control}},{summary,approvalAssessment:{risk:'high',confidence:1,reason:summary+control}}]){
   assert.equal(reviewSummarySchema().safeParse(value).success,false);
  }
 }
 assert.equal(reviewSummarySchema().safeParse({summary:summary+'\n\t`SELECT * FROM users`\r\n'}).success,true);
});

test("requirements coverage links use fetched context provenance with safe bounded rendering",()=>{
 const data={overview:"Changes billing arithmetic.",files:[],findings:[],resolved:[],assessment:undefined,runtimeEvidence:undefined,coverageLimits:[],contextCount:2,candidates:0,suppressed:0};
 const jira={path:"requirements/atlassian/connection/site/KAN-1.md",provenance:{repository:"Atlassian: [workspace]",revision:"2026-10-03T00:00:00Z",sourceUrl:"https://example.atlassian.net/browse/KAN-1"}};
 const summary=reviewSummary({...data,requirementsContext:[jira,jira,{...jira,path:"context/repo/code.ts"},{...jira,provenance:{...jira.provenance,sourceUrl:"javascript:alert(1)"}},{...jira,provenance:{...jira.provenance,sourceUrl:"https://secret@example.atlassian.net/browse/KAN-2"}}]},[]);
 assert.equal(summary.split(jira.provenance.sourceUrl).length-1,1);assert.ok(summary.includes("Atlassian: \\[workspace\\]"));assert.ok(summary.includes("revision `2026-10-03T00:00:00Z`"));assert.equal(summary.includes("javascript:"),false);assert.equal(summary.includes("secret@"),false);assert.ok(summary.includes("Not executed by OpenReview"));
 const many=Array.from({length:25},(_,i)=>({...jira,path:`requirements/atlassian/c/s/KAN-${i+1}.md`,provenance:{...jira.provenance,sourceUrl:`https://example.atlassian.net/browse/KAN-${i+1}`}}));
 const bounded=reviewSummary({...data,requirementsContext:many});assert.equal((bounded.match(/https:\/\/example.atlassian.net/g)??[]).length,20);assert.ok(bounded.includes("5 additional fetched requirements links omitted"));
 assert.equal(reviewSummary(data).includes("Fetched requirements"),false);
});

test("verified finding nouns near test references do not imply test execution",()=>{
 const schema=reviewSummarySchema();
 assert.equal(schema.safeParse({summary:"No test or deployment coverage exists to contradict this, and the sole verified finding establishes the code contract violation."}).success,true);
 assert.equal(schema.safeParse({summary:"Test source documents the expected assertion, while the verified defect concerns cents conversion."}).success,true);
 for(const summary of ["Tests verified the finding and confirmed the fix.","Test execution verified findings in the implementation.","The verified finding was corrected and the tests passed.","The tests confirm the verified defect."]){assert.equal(schema.safeParse({summary}).success,false,summary);}
});

test('candidate and verifier prose cannot manufacture runtime outcomes; test source remains usable evidence',async()=>{
 const fixture=new FixtureModel();let reviewerChecked=false,verifierChecked=false;
 const model:ModelProvider={generate:async<T>(request:ModelRequest,schema:z.ZodType<T>)=>{
  if(request.task==='review:correctness'){
   for(const claim of ['Regression tests fail after this change.','This defect is test-verified by the billing suite.'])assert.equal(schema.safeParse({findings:[{...candidate,description:claim}]}).success,false,claim);
   assert.equal(schema.safeParse({findings:[{...candidate,description:'Test source asserts that deleted accounts cannot access the route.'}]}).success,true);reviewerChecked=true;
  }
  if(request.task==='verify'){
   for(const reason of ['The first candidate has explicit, test-verified breakage of the integer cents contract and test failures.','The regression tests fail because the cents contract changed.'])assert.equal(schema.safeParse({decisions:[{index:0,publish:false,reason,confidence:1}]}).success,false,reason);
   const result=await fixture.generate(request,schema);verifierChecked=true;
   return {...result,value:schema.parse({decisions:[{index:0,publish:false,reason:'Static source establishes the same defect as another candidate.',confidence:1}]})};
  }
  if(request.task==='summary')return {value:schema.parse({summary:'No findings were published after conservative static verification.',reviewScore:{value:3,reason:'Static review found insufficient evidence to publish the candidate.'},approvalAssessment:{risk:'unknown',confidence:.5,reason:'No execution evidence was recorded; static uncertainty remains.'}}),usage:{provider:'fixture',model:'fixture',task:'summary',inputTokens:0,outputTokens:0,latencyMs:0,estimatedCost:0,cached:false}};
  return fixture.generate(request,schema);
 }};
 const result=await reviewChange({...input,settings:{categories:['correctness']}},model);
 assert.equal(reviewerChecked,true);assert.equal(verifierChecked,true);assert.equal(result.findings.length,0);assert.match(result.metadata.suppressions?.[0].reason??'',/Static source/);assert.match(result.summary,/Not executed by OpenReview/);
});
