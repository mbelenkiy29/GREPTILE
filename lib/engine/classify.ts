/**
 * Change classification (R6.7). A heuristic pass over paths, index file tags, and diff content picks subsystems,
 * languages, risk areas, dependency impact, and which specialized agents run (each with a reason, and each skipped
 * agent with why). In standard and deep mode a cheap `classify` model call refines subsystems and risk areas and may
 * add agents; it can never remove `correctness`. The mode caps how many agents run; `settings.categories` limits
 * which may run. `focus: "security"` (R4.4) runs the dedicated security profile instead.
 */
import { z } from "zod";
import { detectFileType, isTestPath } from "@/lib/indexer/filetypes";
import { errorMessage } from "@/lib/log";
import type { ContextBundle } from "@/lib/retrieval";
import { componentOf } from "@/lib/retrieval/signals";
import { renderDiff, type FileDiff } from "@/lib/review/diff";
import { truncateToTokens } from "@/lib/llm/budget";
import { AGENTS, type AgentPlan } from "./agents";
import { callJson, record, type EngineContext } from "./calls";
import { modeProfile } from "./modes";
import { dataBlock, dataHandlingInstructions } from "./prompt";
import { AGENT_IDS, type AgentId, type ChangeClassification, type ReviewFocus, type ReviewMode } from "./types";

export interface SecretHit {
  path: string;
  line: number;
  rule: string;
  preview: string;
}

export interface ClassifyInput {
  mode: ReviewMode;
  focus: ReviewFocus | null;
  /** Files agents review (incremental runs review a subset of the diff). */
  diffs: FileDiff[];
  bundle: ContextBundle;
  /** Index tags of changed files (absent for files new in the PR). */
  fileTags: ReadonlyMap<string, readonly string[]>;
  allowed: readonly AgentId[];
  hasRules: boolean;
  hasInstructions: boolean;
  secretHits: SecretHit[];
}

interface AgentCandidate {
  id: AgentId;
  reason: string;
  weight: number;
}

export interface Classified {
  classification: ChangeClassification;
  plan: AgentPlan[];
}

const SQL = /\b(?:SELECT\s[\s\S]*?\bFROM|INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+(?:TABLE|COLUMN|INDEX)|CREATE\s+(?:TABLE|INDEX|UNIQUE))\b/i;
const ORM = /\.(?:query|execute|raw|select|insert|update|delete|findMany|findFirst|findUnique|findOne|aggregate|upsert|transaction)\s*\(/;
const AUTH = /\b\w*(?:auth|session|token|passw(?:or)?d|permission|role|jwt|oauth|crypto|cipher|hmac|signature|secret|csrf|login|acl|tenant|org_?id|orgId)\w*\b/i;
const INPUT = /JSON\.parse|req\.(?:body|query|params|headers)|searchParams|request\.(?:json|formData|body)|formData\(|deserializ|yaml\.(?:load|parse)|pickle\.loads?|\beval\s*\(|new Function\(|\.safeParse\(|\.parse\(|unmarshal|readObject\(/i;
const LOOP = /\b(?:for|while)\b\s*\(|\bfor\s+\w+\s+in\b|\.(?:map|forEach|flatMap|reduce)\s*\(/;
const IO = /\bawait\b|fetch\(|\.(?:query|execute|select|insert|update|find\w*|get|post|put)\s*\(|axios|requests\.|http\.|db\./;
const MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic\/versions)\//i;

function added(d: FileDiff): string[] {
  return d.lines.filter((l) => l.kind === "add").map((l) => l.text);
}

/** A loop introduced or edited by the diff with I/O inside it (the next few lines). */
function loopWithIo(d: FileDiff): number | null {
  for (let i = 0; i < d.lines.length; i++) {
    const l = d.lines[i]!;
    if (l.kind === "del" || !LOOP.test(l.text)) continue;
    const window = d.lines.slice(i, i + 8).filter((x) => x.kind !== "del");
    if (!window.some((x) => x.kind === "add")) continue;
    if (IO.test(l.text.replace(LOOP, "")) || window.slice(1).some((x) => IO.test(x.text))) return l.newLine ?? null;
  }
  return null;
}

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  java: "Java",
  rust: "Rust",
  csharp: "C#",
};

/** The deterministic part of classification. */
export function heuristicClassification(input: ClassifyInput): { classification: Omit<ChangeClassification, "agents" | "skippedAgents">; candidates: AgentCandidate[] } {
  const { diffs, bundle } = input;
  const risk = new Set<string>();
  const why: Partial<Record<string, string[]>> = {};
  const note = (area: string, detail: string) => {
    risk.add(area);
    (why[area] ??= []).push(detail);
  };
  const languages = new Set<string>();
  const subsystems = new Set<string>();
  let sourceLinesAdded = 0;
  let sourceFiles = 0;

  for (const d of diffs) {
    const type = detectFileType(d.path);
    if (type) languages.add(LANGUAGE_NAMES[type.treeSitter?.id ?? ""] ?? type.language);
    subsystems.add(componentOf(d.path));
    const tags = input.fileTags.get(d.path) ?? [];
    const lines = added(d);
    const isTest = isTestPath(d.path);
    if (!isTest && type?.category === "code") {
      sourceLinesAdded += lines.length;
      sourceFiles++;
    }
    if (tags.includes("migration") || MIGRATION_PATH.test(d.path)) note("migration", `${d.path} is a migration`);
    if (tags.includes("schema")) note("database", `${d.path} is a schema file`);
    if (lines.some((l) => SQL.test(l))) note("database", `SQL in ${d.path}`);
    else if (lines.some((l) => ORM.test(l))) note("database", `query calls in ${d.path}`);
    const authLine = lines.find((l) => AUTH.test(l));
    if (authLine) note("authentication/authorization", `${AUTH.exec(authLine)![0]} in ${d.path}`);
    if (lines.some((l) => INPUT.test(l))) note("input parsing", `input parsing in ${d.path}`);
    if (tags.includes("route") || /(^|\/)(routes?|controllers?|handlers?|api)\//.test(d.path)) note("routes", `${d.path} serves requests`);
    const loop = loopWithIo(d);
    if (loop !== null) note("performance", `I/O inside a loop at ${d.path}:${loop}`);
    if (isTest) note("tests", `${d.path} changed`);
    if (type?.manifest) note("dependencies", `${d.path} changed`);
  }
  for (const c of bundle.changed) {
    if (c.kind === "route") note("routes", `route ${c.name} changed`);
    if ((c.kind === "table" || c.kind === "model") && c.change !== "added") note("database", `${c.kind} ${c.name} changed`);
    if (c.exported && c.change === "removed") note("public API", `exported ${c.qualifiedName} removed`);
    if (c.exported && c.change === "modified" && c.baseSignature !== null && c.baseSignature !== c.signature) note("public API", `signature of ${c.qualifiedName} changed`);
  }
  if (sourceFiles > 0 && !diffs.some((d) => isTestPath(d.path)) && sourceLinesAdded >= 5) note("missing tests", `${sourceLinesAdded} source lines changed without test changes`);
  for (const s of input.secretHits) note("secrets", `${s.rule} at ${s.path}:${s.line}`);

  const dependencyImpact = [
    ...bundle.dependencyChanges.map((c) => `${c.manifest}: ${c.name} ${c.change}${c.from && c.to ? ` (${c.from} → ${c.to})` : c.to ? ` (${c.to})` : ""}`),
    ...bundle.externalDependents.map((e) => `${e.symbol} (${e.path}) has ${e.dependents.length} dependent file${e.dependents.length === 1 ? "" : "s"}: ${e.dependents.slice(0, 5).join(", ")}${e.dependents.length > 5 ? ", …" : ""}`),
  ];

  const candidates: AgentCandidate[] = [{ id: "correctness", reason: "always reviews logic and cross-file impact", weight: 100 }];
  const reasonFor = (areas: string[]) => areas.flatMap((a) => (why[a] ?? []).slice(0, 2)).join("; ");
  const has = (...areas: string[]) => areas.filter((a) => risk.has(a));

  const sec = has("secrets", "authentication/authorization", "input parsing", "dependencies", "routes");
  if (sec.length) candidates.push({ id: "security", reason: `${sec.join(", ")}: ${reasonFor(sec)}`, weight: risk.has("secrets") ? 7 : risk.has("authentication/authorization") ? 6 : 5 });
  const data = has("migration", "database");
  if (data.length) candidates.push({ id: "data", reason: `${data.join(", ")}: ${reasonFor(data)}`, weight: risk.has("migration") ? 6 : 5 });
  const breaking = has("public API", "routes");
  const dependents = bundle.externalDependents.filter((e) => e.dependents.length > 0);
  if (risk.has("public API") || (risk.has("routes") && dependents.length) || dependents.some((e) => bundle.changed.some((c) => c.qualifiedName === e.symbol && c.baseSignature !== null && c.baseSignature !== c.signature))) {
    candidates.push({ id: "api_compat", reason: `${breaking.join(", ") || "exported symbols"}: ${reasonFor(breaking) || dependencyImpact.join("; ")}`, weight: dependents.length ? 5 : 4 });
  }
  const perf = has("performance");
  if (perf.length || (risk.has("database") && diffs.some((d) => loopWithIo(d) !== null))) candidates.push({ id: "performance", reason: reasonFor(["performance"]) || "queries near loops", weight: 4 });
  const testing = has("tests", "missing tests");
  if (testing.length) candidates.push({ id: "testing", reason: `${testing.join(", ")}: ${reasonFor(testing)}`, weight: 3 });
  if (input.hasRules || input.hasInstructions) {
    candidates.push({ id: "rules", reason: input.hasRules ? "team rules apply to the changed files" : "repository instructions apply", weight: input.hasRules ? 4 : 2 });
  }

  return {
    classification: { subsystems: [...subsystems].sort(), languages: [...languages].sort(), riskAreas: [...risk].sort(), dependencyImpact },
    candidates,
  };
}

const NOT_TRIGGERED: Record<AgentId, string> = {
  correctness: "always runs",
  security: "no auth, input parsing, secrets, routes, or dependency changes",
  data: "no database, schema, or migration changes",
  api_compat: "no exported signature, route, or public API changes with dependents",
  performance: "no loops with I/O or query changes",
  testing: "no test changes and no untested source changes",
  rules: "no team rules or repository instructions apply",
};

const refinementSchema = z.object({
  subsystems: z.array(z.string()).describe("Functional subsystems the change touches, e.g. billing, auth, checkout API"),
  riskAreas: z.array(z.string()).describe("Risk areas, e.g. database, authentication/authorization, concurrency"),
  additionalAgents: z
    .array(z.object({ id: z.enum(AGENT_IDS), reason: z.string() }))
    .describe("Extra specialized reviewers this change needs that the heuristics missed (may be empty)"),
});

const CLASSIFY_SYSTEM = `You classify pull requests for OpenReview's review router. Given the changed files, the heuristic
classification, and the diff, name the functional subsystems the change touches, its risk areas, and any specialized
reviewers the heuristics missed. Reviewers: correctness, security, data (migrations, schema, transactions, queries),
api_compat (breaking changes for consumers), testing, performance, rules (team rules). Only add a reviewer when the
diff clearly needs it. Keep lists short.

${dataHandlingInstructions()}`;

/** Classifies the change and plans which agents run (R6.7, R4.1, R4.4). */
export async function classifyChange(ctx: EngineContext, input: ClassifyInput): Promise<Classified> {
  const profile = modeProfile(input.mode);
  const { classification: base, candidates } = heuristicClassification(input);
  const subsystems = new Set(base.subsystems);
  const riskAreas = new Set(base.riskAreas);

  if (input.focus === "security") {
    // An explicit security review always runs the security agent (the request overrides settings.categories for
    // that one agent); the supporting correctness pass honors settings.categories like any other agent.
    const correctnessAllowed = input.allowed.includes("correctness");
    const agents: ChangeClassification["agents"] = [
      {
        id: "security",
        reason: input.allowed.includes("security")
          ? "security review requested: dedicated security profile at deep effort"
          : "security review requested explicitly (overrides the repository's disabled security category): dedicated security profile at deep effort",
      },
      ...(correctnessAllowed ? [{ id: "correctness" as const, reason: "security review: security-relevant logic only" }] : []),
    ];
    await record(ctx, { agent: "classifier", status: "skipped", model: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, latencyMs: 0, candidates: 0, accepted: 0 });
    return {
      classification: {
        ...base,
        agents,
        skippedAgents: AGENT_IDS.filter((id) => !agents.some((a) => a.id === id)).map((id) => ({
          id,
          reason: id === "correctness" ? "disabled in repository settings" : "security review runs only the security profile",
        })),
      },
      plan: [{ id: "security", mode: "deep" }, ...(correctnessAllowed ? [{ id: "correctness" as const, mode: input.mode }] : [])],
    };
  }

  if (profile.modelClassification && input.diffs.length) {
    const diffText = truncateToTokens(input.diffs.map(renderDiff).join("\n\n"), 6000);
    const res = await callJson(ctx, "classifier", {
      task: "classify",
      cache: true,
      system: CLASSIFY_SYSTEM,
      prompt: [
        "Classify this change.",
        dataBlock("classification", ctx.nonce, JSON.stringify({ ...base, suggestedAgents: candidates.map((c) => ({ id: c.id, reason: c.reason })) }, null, 2)),
        dataBlock("diff", ctx.nonce, diffText),
      ].join("\n\n"),
      schema: refinementSchema,
      schemaName: "change_classification",
    });
    if (res.ok) {
      for (const s of res.value.data.subsystems.slice(0, 8)) subsystems.add(s.trim().slice(0, 60));
      for (const r of res.value.data.riskAreas.slice(0, 8)) riskAreas.add(r.trim().toLowerCase().slice(0, 60));
      for (const a of res.value.data.additionalAgents) {
        if (!candidates.some((c) => c.id === a.id)) candidates.push({ id: a.id, reason: `classifier: ${a.reason.slice(0, 200)}`, weight: 3 });
      }
    }
    await record(ctx, {
      agent: "classifier",
      status: res.ok ? "ok" : "error",
      model: res.ok ? res.value.model : res.failure.model,
      usage: res.ok ? res.value.usage : res.failure.usage,
      costUsd: res.ok ? res.value.costUsd : res.failure.costUsd,
      latencyMs: res.ok ? res.value.latencyMs : res.failure.latencyMs,
      candidates: 0,
      accepted: 0,
      ...(res.ok ? {} : { error: errorMessage(res.failure.error) }),
    });
  } else {
    await record(ctx, { agent: "classifier", status: "skipped", model: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, latencyMs: 0, candidates: 0, accepted: 0 });
  }

  const allowed = new Set(input.allowed);
  const agents: ChangeClassification["agents"] = [];
  const skipped: ChangeClassification["skippedAgents"] = [];
  const ordered = [...candidates].sort((a, b) => b.weight - a.weight || AGENTS[b.id].priority - AGENTS[a.id].priority);
  for (const c of ordered) {
    if (!allowed.has(c.id)) {
      skipped.push({ id: c.id, reason: "disabled in repository settings" });
      continue;
    }
    if (agents.length >= profile.maxAgents) {
      skipped.push({ id: c.id, reason: `${input.mode} mode runs at most ${profile.maxAgents} agents (${c.reason})` });
      continue;
    }
    agents.push({ id: c.id, reason: c.reason });
  }
  for (const id of AGENT_IDS) {
    if (!candidates.some((c) => c.id === id)) skipped.push({ id, reason: NOT_TRIGGERED[id] });
  }
  skipped.sort((a, b) => AGENT_IDS.indexOf(a.id) - AGENT_IDS.indexOf(b.id));

  return {
    classification: { subsystems: [...subsystems].sort(), languages: base.languages, riskAreas: [...riskAreas].sort(), dependencyImpact: base.dependencyImpact, agents, skippedAgents: skipped },
    plan: agents.map((a) => ({ id: a.id, mode: input.mode })),
  };
}
