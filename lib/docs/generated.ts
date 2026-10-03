/**
 * Reference pages generated at build time from the code that defines them (R5.3), so the docs cannot drift:
 *
 * - the `openreview.json` reference from the zod schema the server validates the file with (`repoConfigSchema`),
 * - the environment variable table from `.env.example` (which lists every variable, H5),
 * - the REST API reference from the OpenAPI document (`openApiDocument`), itself generated from the route table.
 *
 * Each generator returns plain Markdown; the docs renderer compiles it like any other page segment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openApiDocument } from "@/lib/api/openapi";
import { CONFIG_FILE, repoConfigSchema } from "@/lib/config/repo-config";
import { SETTING_DEFAULTS } from "@/lib/config/settings";
import { creditsFor, MODE_PROFILES } from "@/lib/engine/modes";

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  description?: string;
  [k: string]: unknown;
};

/** Text for a Markdown table cell: one line, pipes escaped. */
export function cell(text: string): string {
  // `<` outside code spans is escaped so text like `<APP_URL>` is never read as HTML.
  const escaped = text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part : part.replace(/</g, "&lt;")))
    .join("");
  return escaped.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/** A short, human-readable type for a JSON Schema node, e.g. `string[]`, `"fast" | "deep"`, `integer`. */
export function typeLabel(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.anyOf) return s.anyOf.map(typeLabel).join(" or ");
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (t === "array") {
    const inner = s.items ? typeLabel(s.items) : "unknown";
    return s.items?.enum || s.items?.anyOf ? `(${inner})[]` : `${inner}[]`;
  }
  if (t === "object" && !s.properties && s.additionalProperties && typeof s.additionalProperties === "object") {
    return `{ [name]: ${typeLabel(s.additionalProperties)} }`;
  }
  return t ?? "any";
}

/** Limits on a JSON Schema node in words, e.g. "0–100", "at most 50 items". */
export function limits(s: JsonSchema): string[] {
  const out: string[] = [];
  if (s.minimum !== undefined && s.maximum !== undefined) out.push(`${s.minimum}–${s.maximum}`);
  else if (s.minimum !== undefined) out.push(`≥ ${s.minimum}`);
  else if (s.maximum !== undefined) out.push(`≤ ${s.maximum}`);
  if (s.minItems) out.push(`at least ${s.minItems} item${s.minItems === 1 ? "" : "s"}`);
  if (s.maxItems !== undefined) out.push(`at most ${s.maxItems} items`);
  if (s.maxLength !== undefined) out.push(`at most ${s.maxLength} characters`);
  return out;
}

/**
 * What each top-level `openreview.json` key does. Keys come from the schema; a test fails when the schema gains a key
 * without an entry here (or an entry outlives its key).
 */
export const CONFIG_KEY_DOCS: Record<string, string> = {
  $schema: "Optional JSON Schema URL for editor completion. Ignored by the server.",
  rules:
    "Review rules in plain English, in addition to the rules managed in the dashboard. Each entry is a string, or an object with `rule` and optional `paths` (globs the rule is limited to).",
  autoReview: "Review pull requests automatically when they are opened or reopened. When off, reviews run only when someone asks for one.",
  reviewDrafts: "Also review draft pull requests automatically.",
  targetBranches: "Base branches (globs) whose pull requests are reviewed automatically. Empty means every branch.",
  ignoredBranches: "Pull requests whose head or base branch matches one of these globs are not reviewed automatically.",
  ignore: "Path globs that are left out of reviews (generated code, vendored files, fixtures).",
  maxComments: "Most inline comments posted on one review. The most severe, most confident findings are kept.",
  minConfidence: "Findings below this verified confidence (0–1) are not posted.",
  minSeverity: "Findings below this severity are not posted.",
  categories: "Specialized reviewers to run; each one is also a finding category.",
  commentTypes: "Older switch for the same purpose as `categories` (`logic` = correctness, `security`, `style` = rules). `categories` wins when both are set.",
  model: "Model id for this repository's reviews, overriding the server's routing for the review task.",
  mode: "Review depth: `fast`, `standard` (default), or `deep`. See Review modes & cost.",
  customInstructions: "Extra guidance for the reviewers, such as what this codebase cares about most.",
  autoReReview: "Review new commits pushed to an open pull request (incrementally) without being asked.",
  commentStyle: "`concise` comments keep to the point; `detailed` comments include every piece of evidence.",
  strictness:
    "Preset for `minConfidence`, `maxComments`, and `minSeverity` when those are not set explicitly: `low` posts fewer, surer findings; `high` posts more.",
  context: "Path globs of documents (CONTRIBUTING.md, ADRs, style guides) that are always given to the reviewers as context.",
  runtimeValidation: "Runs the pull request's tests in an isolated container and attaches the result to the review (beta). See the table below.",
};

/** What each `runtimeValidation` key does (same drift test as {@link CONFIG_KEY_DOCS}). */
export const RUNTIME_VALIDATION_DOCS: Record<string, string> = {
  enabled: "Turn runtime validation on for this repository.",
  image: "Container image the commands run in. Defaults to the server's `SANDBOX_IMAGE`; operators can restrict the allowed images.",
  install: "Dependency install command, e.g. `npm ci`. It runs before the tests, offline unless `network` is `install-only`.",
  test: "Test command, e.g. `npm test`. Commands run with `sh -c` inside the container only.",
  timeoutSec: "Wall-clock limit for the whole run, never more than the server's `SANDBOX_TIMEOUT_SEC`.",
  network: "`none` (default): no network at all. `install-only`: the install step may reach the package registry proxy.",
  env: "Extra environment variables with literal values (never secrets), e.g. `{ \"CI\": \"true\" }`.",
};

/** The JSON Schema of `openreview.json`, as the docs see it. */
export function configJsonSchema(): JsonSchema {
  return z.toJSONSchema(repoConfigSchema, { io: "input", unrepresentable: "any" }) as JsonSchema;
}

/** Top-level keys of `openreview.json`, from the schema. */
export function configKeys(): string[] {
  return Object.keys(configJsonSchema().properties ?? {});
}

function defaultFor(key: string): string {
  if (key === "strictness") return code(JSON.stringify(SETTING_DEFAULTS.strictness));
  if (key === "minConfidence" || key === "maxComments" || key === "minSeverity") return "from `strictness`";
  if (key === "commentTypes") return "all";
  if (key in SETTING_DEFAULTS) {
    const v = SETTING_DEFAULTS[key as keyof typeof SETTING_DEFAULTS];
    if (v === null) return "server default";
    if (Array.isArray(v)) return v.length ? "all" : "`[]`";
    return code(JSON.stringify(v));
  }
  return "—";
}

function keyTable(props: Record<string, JsonSchema>, docs: Record<string, string>, required: string[], withDefaults: boolean): string {
  const head = withDefaults ? "| Key | Type | Default | Description |\n| --- | --- | --- | --- |" : "| Key | Type | Required | Description |\n| --- | --- | --- | --- |";
  const rows = Object.entries(props).map(([key, s]) => {
    const type = [code(typeLabel(s)), ...limits(s)].join(", ");
    const third = withDefaults ? defaultFor(key) : required.includes(key) ? "yes" : "no";
    return `| ${code(key)} | ${cell(type)} | ${cell(third)} | ${cell(docs[key] ?? "")} |`;
  });
  return [head, ...rows].join("\n");
}

/** The `openreview.json` reference (keys, types, limits, defaults, descriptions) as Markdown. */
export function configReferenceMarkdown(): string {
  const schema = configJsonSchema();
  const props = schema.properties ?? {};
  const rv = props.runtimeValidation ?? {};
  const example = {
    mode: "standard",
    strictness: "medium",
    ignore: ["**/*.generated.ts", "vendor/**"],
    context: ["CONTRIBUTING.md", "docs/adr/**"],
    rules: ["Use the shared logger in lib/log.ts instead of console.log in server code.", { rule: "Every SQL query filters by org_id.", paths: ["lib/data/**"] }],
  };
  return [
    `## Keys`,
    `Every key is optional, and unknown keys are rejected so a typo is reported instead of silently ignored. ${code(CONFIG_FILE)} is read from the pull request's **base** commit, so a pull request cannot weaken its own review by editing the file. An invalid file is reported in the review summary and the dashboard settings apply instead.`,
    keyTable(props, CONFIG_KEY_DOCS, [], true),
    `## runtimeValidation`,
    keyTable(rv.properties ?? {}, RUNTIME_VALIDATION_DOCS, rv.required ?? [], false),
    `## Example`,
    "```json\n" + JSON.stringify(example, null, 2) + "\n```",
  ].join("\n\n");
}

const MODE_ORDER = ["fast", "standard", "deep"] as const;

/** The review modes table (agents, context budgets, graph depth, file cap, default credits) from `MODE_PROFILES`. */
export function modesReferenceMarkdown(source: Record<string, string | undefined> = {}): string {
  const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "all");
  const row = (label: string, value: (m: (typeof MODE_ORDER)[number]) => string) => `| ${label} | ${MODE_ORDER.map((m) => value(m)).join(" | ")} |`;
  return [
    "| | Fast | Standard | Deep |",
    "| --- | --- | --- | --- |",
    row("Credits per review (default)", (m) => String(creditsFor(m, source))),
    row("Specialized reviewers", (m) => fmt(MODE_PROFILES[m].maxAgents)),
    row("Context budget (tokens)", (m) => fmt(MODE_PROFILES[m].contextTokens)),
    row("Definitions of changed symbols (tokens)", (m) => fmt(MODE_PROFILES[m].definitionTokens)),
    row("Dependents followed through the graph", (m) => (MODE_PROFILES[m].dependentDepth === 0 ? "none" : `${MODE_PROFILES[m].dependentDepth} level${MODE_PROFILES[m].dependentDepth > 1 ? "s" : ""}`)),
    row("Changed files reviewed at most", (m) => fmt(MODE_PROFILES[m].maxFiles)),
    row("Model-assisted change classification", (m) => (MODE_PROFILES[m].modelClassification ? "yes" : "no")),
  ].join("\n");
}

export interface EnvVar {
  name: string;
  /** The value in `.env.example` (often empty for secrets). */
  example: string;
  description: string;
  section: string;
}

/**
 * Section of the environment reference each variable starts. Variables not listed here belong to the section of the
 * variable before them, so a new variable needs no change here (it joins the section it was added to).
 */
export const ENV_SECTION_STARTS: Record<string, string> = {
  NODE_ENV: "Runtime",
  POSTGRES_USER: "PostgreSQL",
  REDIS_URL: "Redis",
  SESSION_TTL_DAYS: "Sign-in and sessions",
  GITHUB_APP_ID: "GitHub App",
  GITLAB_URL: "GitLab and Bitbucket Cloud",
  LLM_PROVIDER: "Models",
  EMBEDDING_PROVIDER: "Embeddings",
  REPO_CACHE_DIR: "Indexing, knowledge base, and workers",
  REVIEW_DEBOUNCE_MS: "Review pipeline",
  API_RATE_LIMIT_PER_MINUTE: "REST API and CLI",
  STRIPE_SECRET_KEY: "Plans and billing (optional)",
  SSO_ALLOW_PRIVATE_ISSUERS: "Enterprise and hardening",
  RUNTIME_VALIDATION_ENABLED: "Runtime validation (beta)",
  DEMO_ENABLED: "Public demo",
  APP_PORT: "Docker Compose",
};

/** A comment line that only names a group (e.g. `# GitHub App`), not a description. */
function isGroupLabel(comment: string): boolean {
  return !/[.,;:]/.test(comment) && comment.split(/\s+/).length <= 3;
}

/**
 * Parses `.env.example`: each variable's description is the comment lines directly above it (since the previous
 * variable or blank line), and its section comes from {@link ENV_SECTION_STARTS}.
 */
export function parseEnvExample(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  let section = "General";
  let pending: string[] = [];
  // Whether the pending comments start a blank-line separated block (where a group label can appear).
  let blockStart = true;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      pending = [];
      blockStart = true;
      continue;
    }
    const v = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (v) {
      section = ENV_SECTION_STARTS[v[1]!] ?? section;
      const fromBlockStart = blockStart;
      blockStart = false;
      const description = pending
        .filter((c, i) => !(fromBlockStart && i === 0 && isGroupLabel(c)))
        // Comment lines that end a sentence without a period, followed by a new sentence, get one.
        .reduce((acc, c) => (!acc ? c : /[.:;,(—-]$/.test(acc) || !/^[A-Z]/.test(c) ? `${acc} ${c}` : `${acc}. ${c}`), "");
      out.push({ name: v[1]!, example: v[2]!.trim(), description, section });
      pending = [];
      continue;
    }
    if (line.startsWith("#")) pending.push(line.replace(/^#\s?/, "").trim());
  }
  return out;
}

/** Repository root (where `.env.example` and `content/` live). */
export function repoRoot(): string {
  return process.cwd();
}

export function envExampleVars(root = repoRoot()): EnvVar[] {
  return parseEnvExample(readFileSync(path.join(root, ".env.example"), "utf8"));
}

/** Every variable in `.env.example` as Markdown tables, one per section. */
export function envReferenceMarkdown(root = repoRoot()): string {
  const vars = envExampleVars(root);
  const sections: string[] = [];
  for (const v of vars) if (!sections.includes(v.section)) sections.push(v.section);
  return sections
    .map((s) => {
      const rows = vars
        .filter((v) => v.section === s)
        .map((v) => `| ${code(v.name)} | ${v.example ? code(v.example) : "—"} | ${cell(v.description) || "—"} |`);
      return [`### ${s}`, "| Variable | Example | Description |\n| --- | --- | --- |", ...rows].join("\n");
    })
    .join("\n\n");
}

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  "x-required-scope"?: string | null;
  parameters?: { name: string; in: string; required?: boolean; schema?: JsonSchema }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { description?: string }>;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Example server for the reference (the real document is served by each instance at `/api/v1/openapi.json`). */
export const API_EXAMPLE_ORIGIN = "https://openreview.example.com";

function apiOperations(): { method: string; path: string; op: Operation }[] {
  const doc = openApiDocument(API_EXAMPLE_ORIGIN) as { paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>> };
  const out: { method: string; path: string; op: Operation }[] = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const m of METHODS) {
      const op = item[m];
      if (op) out.push({ method: m.toUpperCase(), path: p, op });
    }
  }
  return out;
}

/** `METHOD /path` for every operation in the OpenAPI document. */
export function apiRouteIds(): string[] {
  return apiOperations().map((o) => `${o.method} ${o.path}`);
}

/** The REST API reference, grouped by tag, as Markdown. */
export function apiReferenceMarkdown(): string {
  const ops = apiOperations();
  const tags: string[] = [];
  for (const o of ops) {
    const t = o.op.tags?.[0] ?? "Other";
    if (!tags.includes(t)) tags.push(t);
  }
  return tags
    .map((tag) => {
      const parts = [`## ${tag}`];
      for (const { method, path: p, op } of ops.filter((o) => (o.op.tags?.[0] ?? "Other") === tag)) {
        parts.push(`### ${method} ${p}`);
        if (op.summary) parts.push(op.summary.endsWith(".") ? op.summary : `${op.summary}.`);
        if (op.description) parts.push(op.description);
        const auth = op.security && op.security.length === 0 ? "No authentication." : op["x-required-scope"] ? `Requires the ${code(op["x-required-scope"])} scope.` : "Any valid API key.";
        parts.push(`**Authentication:** ${auth}`);
        const params = op.parameters ?? [];
        if (params.length) {
          parts.push(
            [
              "| Parameter | In | Type | Required |\n| --- | --- | --- | --- |",
              ...params.map((x) => `| ${code(x.name)} | ${x.in} | ${cell([code(typeLabel(x.schema ?? {})), ...limits(x.schema ?? {})].join(", "))} | ${x.required ? "yes" : "no"} |`),
            ].join("\n"),
          );
        }
        const body = op.requestBody?.content?.["application/json"]?.schema;
        if (body) {
          const props = body.properties ?? {};
          const required = body.required ?? [];
          parts.push(
            [
              "**Request body** (JSON):",
              "",
              "| Field | Type | Required |\n| --- | --- | --- |",
              ...Object.entries(props).map(([k, s]) => `| ${code(k)} | ${cell([code(typeLabel(s)), ...limits(s)].join(", "))} | ${required.includes(k) ? "yes" : "no"} |`),
            ].join("\n"),
          );
        }
        const responses = Object.entries(op.responses ?? {});
        if (responses.length) parts.push(["**Responses:**", "", ...responses.map(([status, r]) => `- ${code(status)} ${r.description ?? ""}`)].join("\n"));
      }
      return parts.join("\n\n");
    })
    .join("\n\n");
}
