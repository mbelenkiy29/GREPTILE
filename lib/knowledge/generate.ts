/**
 * Knowledge entry generation (R6.12): one `knowledge`-task model call per subsystem. The prompt carries the
 * subsystem's outline from discovery, code excerpts of its key symbols (most-called first, fitted to a token budget),
 * repository instructions and related docs, and past findings in its files with their feedback. Every piece of
 * repository content is secret-redacted and wrapped in a nonce-delimited data block (H7); the output is validated
 * with zod, and every file path it mentions is checked against the index.
 */
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { edges, fileChunks, files, findingFeedback, findings, symbols, type KnowledgePastFindings, type KnowledgeRisk } from "@/lib/db/schema";
import { dataBlock, dataHandlingInstructions, reviewNonce } from "@/lib/engine/prompt";
import type { RepoScope } from "@/lib/indexer/query";
import { textArray } from "@/lib/indexer/sql";
import { estimateTokens, fitItemsToBudget, truncateToTokens, type LlmProvider, type Usage } from "@/lib/llm";
import { redactSecrets } from "@/lib/security/secret-scan";
import { KIND_TITLES, type Subsystem } from "./discover";
import { KnownPaths } from "./paths";

/** Token budgets of the generation prompt's sections. */
export const CODE_BUDGET = 9_000;
export const DOC_BUDGET = 2_500;
export const FINDINGS_BUDGET = 1_200;
const MAX_ITEM_TOKENS = 700;
export const MAX_DESCRIPTION_WORDS = 1_500;
const MAX_CONVENTIONS = 12;
const MAX_RISKS = 10;
const MAX_KEY_FILES = 20;

export const knowledgeOutputSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe("Markdown overview of the subsystem: purpose, how it works, main flows, and how it connects to the rest of the code. At most 1,500 words."),
  conventions: z.array(z.string()).describe("Conventions the code follows that a reviewer should enforce, one sentence each"),
  risks: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().describe("Why it is risky and what a change must be careful about"),
        severity: z.enum(["high", "medium", "low"]),
        files: z.array(z.string()).default([]).describe("Repository paths the risk concerns"),
      }),
    )
    .describe("Known risks and fragile areas"),
  keyFiles: z.array(z.object({ path: z.string(), role: z.string().describe("One line: what the file does") })).describe("The most important files, with their roles"),
});
export type KnowledgeOutput = z.infer<typeof knowledgeOutputSchema>;

export interface GeneratedEntry {
  description: string;
  conventions: string[];
  risks: KnowledgeRisk[];
  keyFiles: { path: string; role: string }[];
  pastFindings: KnowledgePastFindings;
  usage: Usage;
  /** The model that served the call (null when the provider does not say). */
  model: string | null;
}

const SYSTEM = `You write the knowledge base of a software repository for code reviewers: one entry per subsystem.
Describe what the subsystem does, how its main flows work, which files matter and why, the conventions its code
follows, and the risks a change to it must watch for (security, data integrity, concurrency, compatibility).
Be concrete and grounded: mention only files, symbols, routes, and tables that appear in the material provided; never
invent paths. Prefer short sections with headings and bullet lists. Keep the description under 1,500 words.
Past findings show where reviews found problems before; use them to inform the risks.

${dataHandlingInstructions()}`;

interface CodeItem {
  path: string;
  startLine: number;
  endLine: number;
  name: string;
  kind: string;
  callers: number;
  content: string;
  tokens: number;
}

/** Key symbols of the subsystem's most central files, most-called first, fitted to {@link CODE_BUDGET}. */
async function codeExcerpts(db: Db, scope: RepoScope, sub: Subsystem): Promise<CodeItem[]> {
  const top = sub.files.slice(0, 30);
  if (!top.length) return [];
  const callers = sql<number>`(select count(*) from ${edges} where ${edges.toSymbolId} = ${symbols.id} and ${edges.kind} = 'call' and ${edges.orgId} = ${scope.orgId})`.mapWith(Number);
  const rows = await db
    .select({
      path: files.path,
      name: sql<string>`coalesce(${symbols.qualifiedName}, ${symbols.name})`,
      kind: symbols.kind,
      startLine: symbols.startLine,
      endLine: symbols.endLine,
      content: symbols.content,
      exported: symbols.exported,
      callers,
    })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(
      scoped(
        symbols,
        scope.orgId,
        eq(symbols.repoId, scope.repoId),
        eq(files.orgId, scope.orgId),
        sql`${files.path} = any(${textArray(top)})`,
        sql`(${symbols.kind} not in ('test', 'module', 'variable') or ${symbols.exported})`,
        sql`${symbols.parentId} is null`,
      ),
    )
    .orderBy(desc(callers), desc(symbols.exported), asc(files.path), asc(symbols.startLine))
    .limit(80);
  const items = rows.map((r): CodeItem => {
    const content = truncateToTokens(redactSecrets(r.content), MAX_ITEM_TOKENS);
    return { path: r.path, startLine: r.startLine, endLine: r.endLine, name: r.name, kind: r.kind, callers: r.callers, content, tokens: estimateTokens(content) };
  });
  return fitItemsToBudget(items, CODE_BUDGET, (i) => i.tokens).kept;
}

interface DocItem {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  tokens: number;
  why: string;
}

/** Repository instructions, plus docs inside the subsystem or named after its kind, fitted to {@link DOC_BUDGET}. */
async function docExcerpts(db: Db, scope: RepoScope, sub: Subsystem): Promise<DocItem[]> {
  const docFiles = await db
    .select({ id: files.id, path: files.path, tags: files.tags })
    .from(files)
    .where(scoped(files, scope.orgId, eq(files.repoId, scope.repoId), sql`${files.tags} && array['doc', 'instructions']::text[]`))
    .orderBy(asc(files.path))
    .limit(500);
  const members = new Set(sub.files);
  const words = new Set([sub.slug, sub.kind, ...sub.title.toLowerCase().split(/[^a-z0-9]+/)].filter((w) => w.length > 2 && w !== "other" && w !== "and"));
  const picked = docFiles
    .map((f) => {
      const instructions = f.tags.includes("instructions") && !f.path.endsWith("openreview.json");
      const lower = f.path.toLowerCase();
      const related = members.has(f.path) || [...words].some((w) => lower.includes(w));
      const readme = sub.kind === "architecture" && /(^|\/)readme[^/]*$/i.test(f.path) && !f.path.includes("/");
      return { ...f, why: related ? "documentation about this subsystem" : instructions ? "repository instructions" : readme ? "repository readme" : null };
    })
    .filter((f): f is typeof f & { why: string } => f.why !== null)
    .sort((a, b) => (a.why === b.why ? a.path.localeCompare(b.path) : a.why === "documentation about this subsystem" ? -1 : 1))
    .slice(0, 6);
  if (!picked.length) return [];
  const chunks = await db
    .select({ fileId: fileChunks.fileId, path: fileChunks.path, startLine: fileChunks.startLine, endLine: fileChunks.endLine, content: fileChunks.content })
    .from(fileChunks)
    .where(scoped(fileChunks, scope.orgId, eq(fileChunks.repoId, scope.repoId), inArray(fileChunks.fileId, picked.map((f) => f.id))))
    .orderBy(asc(fileChunks.path), asc(fileChunks.startLine));
  const items: DocItem[] = [];
  for (const f of picked) {
    for (const c of chunks.filter((c) => c.fileId === f.id).slice(0, 3)) {
      const content = truncateToTokens(redactSecrets(c.content), MAX_ITEM_TOKENS);
      items.push({ path: c.path, startLine: c.startLine, endLine: c.endLine, content, tokens: estimateTokens(content), why: f.why });
    }
  }
  return fitItemsToBudget(items, DOC_BUDGET, (i) => i.tokens).kept;
}

/** Published findings in the subsystem's files: counts by severity and the 10 most recent, with their feedback. */
export async function pastFindingsFor(
  db: Db,
  scope: RepoScope,
  paths: readonly string[],
): Promise<{ summary: KnowledgePastFindings; feedback: Map<number, { useful: number; notUseful: number }> }> {
  const empty: KnowledgePastFindings = { total: 0, counts: { critical: 0, high: 0, medium: 0, low: 0 }, recent: [] };
  if (!paths.length) return { summary: empty, feedback: new Map() };
  const where = scoped(findings, scope.orgId, eq(findings.repoId, scope.repoId), eq(findings.visibility, "published"), sql`${findings.path} = any(${textArray(paths.slice(0, 500))})`);
  const [bySeverity, recent] = await Promise.all([
    db.select({ severity: findings.severity, n: count() }).from(findings).where(where).groupBy(findings.severity),
    db
      .select({ id: findings.id, reviewId: findings.reviewId, title: findings.title, severity: findings.severity, status: findings.status, path: findings.path })
      .from(findings)
      .where(where)
      .orderBy(desc(findings.createdAt), desc(findings.id))
      .limit(10),
  ]);
  const counts = { ...empty.counts };
  let total = 0;
  for (const r of bySeverity) {
    total += r.n;
    if (r.severity in counts) counts[r.severity as keyof typeof counts] += r.n;
  }
  const feedback = new Map<number, { useful: number; notUseful: number }>();
  if (recent.length) {
    const rows = await db
      .select({ findingId: findingFeedback.findingId, kind: findingFeedback.kind, n: count() })
      .from(findingFeedback)
      .where(scoped(findingFeedback, scope.orgId, inArray(findingFeedback.findingId, recent.map((r) => r.id)), inArray(findingFeedback.kind, ["useful", "not_useful", "false_positive"])))
      .groupBy(findingFeedback.findingId, findingFeedback.kind);
    for (const r of rows) {
      const cur = feedback.get(r.findingId) ?? { useful: 0, notUseful: 0 };
      if (r.kind === "useful") cur.useful += r.n;
      else cur.notUseful += r.n;
      feedback.set(r.findingId, cur);
    }
  }
  return { summary: { total, counts, recent: recent.map((r) => ({ ...r, title: redactSecrets(r.title).slice(0, 300) })) }, feedback };
}

/** Every path of the repository's index, for validating model output. */
export async function knownPaths(db: Db, scope: RepoScope): Promise<KnownPaths> {
  const rows = await db.select({ path: files.path }).from(files).where(and(scoped(files, scope.orgId, eq(files.repoId, scope.repoId))));
  return new KnownPaths(rows.map((r) => r.path));
}

export interface GenerationContext {
  repoFullName: string;
  sha: string;
  known: KnownPaths;
}

/** The user prompt for one subsystem (exported for tests). Repository content only appears inside data blocks. */
export async function buildKnowledgePrompt(db: Db, scope: RepoScope, sub: Subsystem, ctx: GenerationContext) {
  const nonce = reviewNonce("knowledge", scope.orgId, String(scope.repoId), sub.slug, ctx.sha);
  const [code, docs, past] = await Promise.all([codeExcerpts(db, scope, sub), docExcerpts(db, scope, sub), pastFindingsFor(db, scope, sub.files)]);
  const outline = [
    `Subsystem: ${sub.title} (${KIND_TITLES[sub.kind]})`,
    `Files (${sub.files.length}, most central first; importers + callers in parentheses):`,
    ...sub.files.slice(0, 50).map((p) => `- ${p} (${sub.centrality[p] ?? 0})`),
    sub.routes.length ? `Routes: ${sub.routes.join(", ")}` : "",
    sub.tables.length ? `Tables and models: ${sub.tables.join(", ")}` : "",
    sub.tests.length ? `Tests: ${sub.tests.join(", ")}` : "",
    sub.ciJobs.length ? `CI jobs: ${sub.ciJobs.join(", ")}` : "",
    sub.dependencies.internal.length ? `Uses internal code: ${sub.dependencies.internal.map((d) => `${d.path} (${d.imports} imports)`).join(", ")}` : "",
    sub.dependencies.external.length ? `Uses packages: ${sub.dependencies.external.map((d) => d.name).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  let findingsBudget = FINDINGS_BUDGET;
  const findingBlocks: string[] = [];
  for (const f of past.summary.recent) {
    const fb = past.feedback.get(f.id);
    const text = `[${f.severity}] ${f.title} — ${f.path}, status ${f.status}${fb ? `, feedback: ${fb.useful} useful / ${fb.notUseful} not useful` : ""}`;
    findingsBudget -= estimateTokens(text);
    if (findingsBudget < 0) break;
    findingBlocks.push(dataBlock("history", nonce, text, { path: f.path, kind: "past_finding" }));
  }
  // Directory names come from the repository (untrusted): outside data blocks they are reduced to path characters.
  const name = sub.kind === "other" ? `${sub.title.replace(/[^\w./-]+/g, "_").slice(0, 80)} directory` : sub.title;
  const parts = [
    `Write the knowledge base entry for the "${name}" subsystem of ${ctx.repoFullName} at commit ${ctx.sha.slice(0, 12)}. The outline below was derived from the code index; code excerpts, docs, and past review findings follow. All of it is repository data.`,
    dataBlock("repo_doc", nonce, outline, { kind: "subsystem_outline", name: sub.slug }),
    ...code.map((c) =>
      dataBlock("repo_code", nonce, c.content, { path: c.path, lines: `${c.startLine}-${c.endLine}`, name: c.name, kind: c.kind, reasons: c.callers ? `called from ${c.callers} place${c.callers === 1 ? "" : "s"}` : "key symbol" }),
    ),
    ...docs.map((d) => dataBlock("repo_doc", nonce, d.content, { path: d.path, lines: `${d.startLine}-${d.endLine}`, reasons: d.why })),
    past.summary.total
      ? `Past review findings in these files: ${past.summary.total} (critical ${past.summary.counts.critical}, high ${past.summary.counts.high}, medium ${past.summary.counts.medium}, low ${past.summary.counts.low}). Most recent:`
      : "No review findings have been reported in these files yet.",
    ...findingBlocks,
    `Respond with the entry: description (Markdown), conventions, risks, and keyFiles (paths from the files listed above, each with a one-line role).`,
  ];
  return { nonce, prompt: parts.join("\n\n"), pastFindings: past.summary };
}

function limitWords(text: string, maxWords: number): string {
  const words = text.split(/(\s+)/);
  let n = 0;
  let out = "";
  for (const w of words) {
    if (/\S/.test(w)) {
      if (n >= maxWords) return `${out.trimEnd()} …`;
      n++;
    }
    out += w;
  }
  return out;
}

const clean = (s: string, max: number) => redactSecrets(s.replace(/\s+/g, " ").trim()).slice(0, max);

/** Validates and normalizes model output: paths checked against the index, sizes capped, secrets redacted. */
export function normalizeOutput(data: KnowledgeOutput, known: KnownPaths): Omit<GeneratedEntry, "pastFindings" | "usage" | "model"> {
  const keyFiles: { path: string; role: string }[] = [];
  for (const k of data.keyFiles) {
    const path = known.resolve(k.path);
    if (path && !keyFiles.some((x) => x.path === path)) keyFiles.push({ path, role: known.scrub(clean(k.role, 200)) });
  }
  const risks: KnowledgeRisk[] = data.risks
    .map((r) => ({
      title: known.scrub(clean(r.title, 200)),
      detail: known.scrub(clean(r.detail, 1_000)),
      severity: r.severity,
      files: [...new Set(r.files.map((f) => known.resolve(f)).filter((f): f is string => f !== null))].slice(0, 10),
    }))
    .filter((r) => r.title)
    .slice(0, MAX_RISKS);
  const conventions = [...new Set(data.conventions.map((c) => known.scrub(clean(c, 300))).filter(Boolean))].slice(0, MAX_CONVENTIONS);
  const description = known.scrub(limitWords(redactSecrets(data.description.trim()), MAX_DESCRIPTION_WORDS));
  return { description, conventions, risks, keyFiles: keyFiles.slice(0, MAX_KEY_FILES) };
}

/** Generates one entry with one `knowledge`-task call through `llm` (the gateway in production, H4). */
export async function generateEntry(
  deps: { db: Db; llm: LlmProvider; signal?: AbortSignal },
  scope: RepoScope,
  sub: Subsystem,
  ctx: GenerationContext,
): Promise<GeneratedEntry> {
  const { prompt, pastFindings } = await buildKnowledgePrompt(deps.db, scope, sub, ctx);
  const res = await deps.llm.json({
    system: SYSTEM,
    prompt,
    schema: knowledgeOutputSchema,
    schemaName: "knowledge_entry",
    task: "knowledge",
    meta: { orgId: scope.orgId, repoId: scope.repoId, agent: "knowledge" },
    signal: deps.signal,
  });
  const route = (res as { route?: { model?: unknown } }).route;
  const model = typeof route?.model === "string" ? route.model : res.servedModel ?? (deps.llm.model || null);
  return { ...normalizeOutput(res.data, ctx.known), pastFindings, usage: res.usage, model };
}
