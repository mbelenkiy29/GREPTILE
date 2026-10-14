import { loadEnvFile } from "node:process";
import { writeFile, mkdir } from "node:fs/promises";
import { fixtures } from "./fixtures";
import { modelFromEnvironment } from "../src/engine/model";
import { reviewChange } from "../src/engine/review";
import {EvaluationUsage} from "../src/evaluation-usage";
import {memoryToolbox} from "../src/engine/agent";
const args=process.argv.slice(2).filter(arg=>arg!=="--");
if(args.includes("--help")||args.includes("-h")){
 console.log("Usage: pnpm eval [--validate] [--fixture=ID] [--engine=pipeline|agentic]\n--validate checks fixtures without model calls. Otherwise a configured model evaluation incurs inference cost.");
 process.exit(0);
}
if(args.some(arg=>arg!=="--validate"&&!arg.startsWith("--fixture=")&&!/^--engine=(pipeline|agentic)$/.test(arg)))throw new Error("Unknown evaluation argument; use --help");
const engine=args.find(a=>a.startsWith("--engine="))?.slice("--engine=".length) as "pipeline"|"agentic"|undefined;
try {
  loadEnvFile(".env.local");
} catch {
  /* Environment variables are sufficient outside local development. */
}
if(new Set(fixtures.map(f=>f.id)).size!==fixtures.length)throw new Error("Duplicate evaluation fixture ID");
for(const f of fixtures){
 const expected=f.expected;
 if(!f.input.diff.length||!f.input.files.length||f.input.baseSha===f.input.headSha||f.input.diff.some(d=>!d.patch))throw new Error("Incomplete fixture: "+f.id);
 if(expected&&(!expected.terms.length||!f.input.diff.some(d=>d.path===expected.path)||!f.input.files.some(s=>s.path===expected.path)))throw new Error("Invalid expected finding: "+f.id);
 const paths=[...f.input.files,...(f.repositoryFiles??[])].map(s=>s.path);
 if(new Set(paths).size!==paths.length||f.repositoryFiles?.some(s=>!s.content.trim()))throw new Error("Invalid repository files: "+f.id);
}
await mkdir("reports", { recursive: true });
if (process.argv.includes("--validate")) {
  console.log(
    JSON.stringify(
      {
        fixtures: fixtures.length,
        status: "fixture validation only; no model quality measured",
        categories: fixtures.map((f) => f.id),
        multiHop: fixtures.filter((f) => f.repositoryFiles?.length).map((f) => f.id),
      },
      null,
      2,
    ),
  );
} else if (
  !process.env.LLM_API_KEY &&
  process.env.LLM_PROVIDER !== "compatible"
) {
  const report = {
    status: "blocked",
    reason:
      "Set LLM_API_KEY (or configure a compatible local endpoint) to run real model evaluation.",
    fixtures: fixtures.length,
    truePositives: null,
    falsePositives: null,
    missedBugs: null,
    parityClaim: false,
  };
  await writeFile("reports/evaluation.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 2;
} else {
  const results = [];
  const only=process.argv.find(a=>a.startsWith("--fixture="))?.slice("--fixture=".length);
  if(only && !fixtures.some(f=>f.id===only))throw new Error("Unknown fixture");
  for (const fixture of fixtures.filter(f=>!only || f.id===only)) {
    const started = Date.now();
    const tracked=new EvaluationUsage(modelFromEnvironment());
    try {
      const result = await reviewChange(fixture.input, tracked, undefined, undefined, engine==="agentic"?{engine,tools:memoryToolbox([...fixture.input.files,...(fixture.repositoryFiles??[])],fixture.input.headSha)}:{});
      const expected=fixture.expected;
      const matched = expected ? result.findings.filter(
        (f) =>
          f.filePath === expected.path &&
          expected.terms.some((term) =>
            `${f.title} ${f.description} ${f.impact}`
              .toLowerCase()
              .includes(term),
          ),
      ) : [];
      results.push({
        id: fixture.id,
        truePositives: matched.length ? 1 : 0,
        trueNegatives: !expected && !result.findings.length ? 1 : 0,
        expectedFindings: expected ? 1 : 0,
        falsePositives: result.findings.length - matched.length,
        missedBugs: expected && !matched.length ? 1 : 0,
        duplicates: Math.max(0, matched.length - 1),
        latencyMs: Date.now() - started,
        tokens: result.usage.reduce(
          (s, u) => s + u.inputTokens + u.outputTokens,
          0,
        ),
        estimatedCost: result.usage.reduce((s, u) => s + u.estimatedCost, 0),
        result,
        usageComplete:true,
      });
    } catch (error) {
      results.push({
        id: fixture.id,
        error: error instanceof Error ? error.message : "Evaluation failed",
        truePositives: null,
        trueNegatives: null,
        falsePositives: null,
        missedBugs: null,
        duplicates: null,
        latencyMs: Date.now() - started,
        ...await tracked.totals(),
      });
    }
  }
  const evaluated = results.filter((result) => !("error" in result));
  const failures = results.length - evaluated.length;
  if (failures) process.exitCode = 1;
  const report = {
    status: failures
      ? evaluated.length
        ? "completed_with_errors"
        : "failed"
      : "completed",
    evaluatedFixtures: evaluated.length,
    failedFixtures: failures,
    scoring:
      "Keyword/location heuristic; human adjudication required before quality claims.",
    model: process.env.LLM_MODEL,
    engine: engine ?? "pipeline",
    usageComplete:results.every(result=>result.usageComplete),
    inferenceUsage:{tokens:results.reduce((sum,result)=>sum+(result.tokens??0),0),estimatedCost:results.reduce((sum,result)=>sum+(result.estimatedCost??0),0)},
    results,
    totals: evaluated.length
      ? results.reduce(
          (a, r) => ({
            truePositives: a.truePositives + (r.truePositives ?? 0),
            trueNegatives: a.trueNegatives + (r.trueNegatives ?? 0),
            falsePositives: a.falsePositives + (r.falsePositives ?? 0),
            missedBugs: a.missedBugs + (r.missedBugs ?? 0),
            duplicates: a.duplicates + (r.duplicates ?? 0),
            latencyMs: a.latencyMs + r.latencyMs,
            tokens: a.tokens + (r.tokens ?? 0),
            estimatedCost: a.estimatedCost + (r.estimatedCost ?? 0),
          }),
          {
            truePositives: 0,
            trueNegatives: 0,
            falsePositives: 0,
            missedBugs: 0,
            duplicates: 0,
            latencyMs: 0,
            tokens: 0,
            estimatedCost: 0,
          },
        )
      : null,
  };
  await writeFile("reports/evaluation"+(only?"-"+only:"")+".json", JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ...report,
        results: results.map((r) => ({
          id: r.id,
          truePositives: r.truePositives,
          trueNegatives: r.trueNegatives,
          falsePositives: r.falsePositives,
          missedBugs: r.missedBugs,
          duplicates: r.duplicates,
          latencyMs: r.latencyMs,
          tokens: r.tokens,
          estimatedCost: r.estimatedCost,
        })),
      },
      null,
      2,
    ),
  );
}
