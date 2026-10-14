import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtures } from "./fixtures";
import { modelFromEnvironment } from "../src/engine/model";
import { reviewChange, fixPrompt } from "../src/engine/review";
try {
  loadEnvFile(".env.local");
} catch {
  /* Explicit environment configuration is sufficient. */
}
const { values } = parseArgs({
  options: {
    fixture: { type: "string", default: "cross-file" },
    output: { type: "string", default: "reports/demo" },
    list: { type: "boolean" },
  },
});
if (values.list) console.log(fixtures.map((fixture) => fixture.id).join("\n"));
else {
  const fixture = fixtures.find((f) => f.id === values.fixture);
  if (!fixture)
    throw new Error(`Unknown fixture. Use --list to see supported fixtures.`);
  if (!process.env.LLM_API_KEY && process.env.LLM_PROVIDER !== "compatible")
    throw new Error(
      "Configure LLM_API_KEY or a compatible endpoint. Demo uses the real review engine and never fabricates findings.",
    );
  const result = await reviewChange(
    fixture.input,
    modelFromEnvironment(),
    async (stage) => {
      console.error(stage);
    },
  );
  const prefix = path.resolve(values.output!);
  await mkdir(path.dirname(prefix), { recursive: true });
  await writeFile(
    `${prefix}.json`,
    JSON.stringify(
      { fixture: fixture.id, input: fixture.input, result },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const fence = (text: string) =>
    "```text\n" + text.replaceAll("```", "` ` `") + "\n```";
  const report = [
    `# OpenReview local demo: ${fixture.id}`,
    "This simulated PR ran through the real engine and configured model. Findings below are model results, not seeded answers.",
    result.summary,
    "## Findings",
    ...result.findings.map(
      (f) =>
        `### ${f.severity.toUpperCase()}: ${f.title}\n\n${f.filePath}:${f.startLine} · ${Math.round(f.confidence * 100)}% confidence\n\n${f.description}\n\nImpact: ${f.impact}\n\n${f.evidence.map((e) => `${e.filePath}:${e.startLine}\n\n${fence(e.quote)}`).join("\n\n")}\n\nSuggested fix: ${f.suggestedFix}`,
    ),
    ...(result.findings.length
      ? [
          "## Fix with an agent",
          fence(
            fixPrompt(
              fixture.input.repository,
              fixture.input.title,
              result.findings,
            ),
          ),
        ]
      : [
          "No findings passed verification. This is a real result, not proof the fixture is safe.",
        ]),
    "## Retrieved context",
    ...result.metadata.context.map((c) => `- ${c.path}: ${c.reason}`),
    "## Usage",
    fence(JSON.stringify(result.usage, null, 2)),
  ].join("\n\n");
  await writeFile(`${prefix}.md`, report, { mode: 0o600 });
  console.log(
    JSON.stringify({
      fixture: fixture.id,
      findings: result.findings.length,
      json: `${prefix}.json`,
      report: `${prefix}.md`,
    }),
  );
}
