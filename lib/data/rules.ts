/**
 * Review rules (R2.1, R2.5, R6.11): plain-English rules with a title, category, default severity, instructions,
 * path globs, org or repository scope, and an on/off switch. Mined candidates (R2.5) wait for approval. Every
 * function is tenant-scoped by `orgId`.
 */
import { and, count, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { can, type Role } from "@/lib/auth/permissions";
import { authorizeRequest } from "@/lib/auth/request";
import type { SessionClock } from "@/lib/auth/sessions";
import type { Db } from "@/lib/db";
import { files, findings, repos, rules } from "@/lib/db/schema";
import { searchPaths } from "@/lib/indexer/query";
import { globMatch, RULE_CATEGORIES, RULE_SEVERITIES, ruleTemplate, type ReviewRule, type RuleCategory, type RuleSeverity } from "@/lib/rules";
import type { RuleFormErrors, RuleFormState } from "@/lib/rules/form-state";
import { scoped } from "./tenant";

export type RuleRow = typeof rules.$inferSelect;
type RuleStatus = RuleRow["status"];

export class RuleValidationError extends Error {}

export const MAX_RULE_PATHS = 50;

function cleanPaths(paths: string[] | undefined) {
  return [...new Set((paths ?? []).map((p) => p.trim()).filter(Boolean))];
}

const pathsSchema = z
  .array(z.string().max(200, "Each path pattern is at most 200 characters."))
  .max(MAX_RULE_PATHS, `At most ${MAX_RULE_PATHS} path patterns.`)
  .transform(cleanPaths);

/** Fields a person sets on a rule (R6.11). */
const ruleFieldsSchema = z.object({
  title: z.string().trim().max(120, "Keep the title under 120 characters."),
  text: z.string().trim().min(5, "Write the rule in at least 5 characters.").max(2000, "Keep the rule under 2,000 characters."),
  category: z.enum(RULE_CATEGORIES, { message: "Pick a category." }),
  severity: z.enum(RULE_SEVERITIES, { message: "Pick a severity." }),
  enabled: z.boolean(),
  instructions: z.string().trim().max(4000, "Keep instructions under 4,000 characters."),
  paths: pathsSchema,
});

export interface RuleInput {
  text: string;
  title?: string;
  category?: RuleCategory;
  severity?: RuleSeverity;
  enabled?: boolean;
  instructions?: string;
  repoId?: number | null;
  paths?: string[];
  status?: RuleStatus;
  source?: string;
  rationale?: string | null;
  evidence?: RuleRow["evidence"];
  createdBy?: string | null;
}

export type RulePatch = Partial<Pick<RuleInput, "text" | "title" | "category" | "severity" | "enabled" | "instructions" | "paths" | "repoId" | "status">>;

function invalid(err: z.ZodError): never {
  throw new RuleValidationError(err.issues[0]?.message ?? "Invalid rule.");
}

async function assertRepoInOrg(db: Db, orgId: string, repoId: number | null | undefined) {
  if (repoId == null) return;
  const [r] = await db.select({ id: repos.id }).from(repos).where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!r) throw new RuleValidationError("Repository not found in this organization.");
}

export async function createRule(db: Db, orgId: string, input: RuleInput): Promise<RuleRow> {
  const parsed = ruleFieldsSchema.safeParse({
    title: input.title ?? "",
    text: input.text,
    category: input.category ?? "rules",
    severity: input.severity ?? "medium",
    enabled: input.enabled ?? true,
    instructions: input.instructions ?? "",
    paths: input.paths ?? [],
  });
  if (!parsed.success) invalid(parsed.error);
  await assertRepoInOrg(db, orgId, input.repoId);
  const [row] = await db
    .insert(rules)
    .values({
      orgId,
      repoId: input.repoId ?? null,
      ...parsed.data,
      status: input.status ?? "active",
      source: input.source ?? "dashboard",
      rationale: input.rationale ?? null,
      evidence: input.evidence ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row!;
}

export interface RuleListFilter {
  status?: RuleStatus[];
  repoId?: number;
  /** `org`: org-wide rules only; `repo`: repository rules only (of `repoId` when set). */
  scope?: "org" | "repo";
  category?: RuleCategory;
  enabled?: boolean;
}

export async function listRules(db: Db, orgId: string, opts: RuleListFilter = {}) {
  return db
    .select({ rule: rules, repoFullName: repos.fullName })
    .from(rules)
    .leftJoin(repos, and(eq(rules.repoId, repos.id), eq(repos.orgId, orgId)))
    .where(
      scoped(
        rules,
        orgId,
        opts.status ? inArray(rules.status, opts.status) : undefined,
        opts.repoId ? eq(rules.repoId, opts.repoId) : undefined,
        opts.scope === "org" ? isNull(rules.repoId) : opts.scope === "repo" ? isNotNull(rules.repoId) : undefined,
        opts.category ? eq(rules.category, opts.category) : undefined,
        opts.enabled !== undefined ? eq(rules.enabled, opts.enabled) : undefined,
      ),
    )
    .orderBy(desc(rules.createdAt), desc(rules.id));
}

export async function getRule(db: Db, orgId: string, ruleId: number): Promise<RuleRow | undefined> {
  const [row] = await db.select().from(rules).where(scoped(rules, orgId, eq(rules.id, ruleId)));
  return row;
}

export async function updateRule(db: Db, orgId: string, ruleId: number, patch: RulePatch) {
  const parsed = ruleFieldsSchema.partial().safeParse({
    title: patch.title,
    text: patch.text,
    category: patch.category,
    severity: patch.severity,
    enabled: patch.enabled,
    instructions: patch.instructions,
    paths: patch.paths,
  });
  if (!parsed.success) invalid(parsed.error);
  await assertRepoInOrg(db, orgId, patch.repoId);
  const set = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const [row] = await db
    .update(rules)
    .set({
      ...set,
      ...(patch.repoId !== undefined ? { repoId: patch.repoId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    })
    .where(scoped(rules, orgId, eq(rules.id, ruleId)))
    .returning();
  return row;
}

/** Turns a rule on or off without deleting it; disabled rules are never sent to reviews (R6.11). */
export async function setRuleEnabled(db: Db, orgId: string, ruleId: number, enabled: boolean) {
  return updateRule(db, orgId, ruleId, { enabled });
}

export async function deleteRule(db: Db, orgId: string, ruleId: number) {
  const rows = await db.delete(rules).where(scoped(rules, orgId, eq(rules.id, ruleId))).returning({ id: rules.id });
  return rows.length > 0;
}

/**
 * Approves (or dismisses) a mined candidate rule (R2.5). Only candidates change: an active or rejected rule is
 * left as it is. Returns the updated rule, or undefined when it is not a candidate of this org.
 */
export async function reviewCandidateRule(db: Db, orgId: string, ruleId: number, decision: "approve" | "reject") {
  const [row] = await db
    .update(rules)
    .set({ status: decision === "approve" ? "active" : "rejected" })
    .where(scoped(rules, orgId, eq(rules.id, ruleId), eq(rules.status, "candidate")))
    .returning();
  return row;
}

/** Adds one of the starter templates (R6.11) as an active rule, org-wide or for one repository. */
export async function applyRuleTemplate(db: Db, orgId: string, input: { templateId: string; repoId?: number | null; createdBy?: string | null }) {
  const t = ruleTemplate(input.templateId);
  if (!t) throw new RuleValidationError("Unknown rule template.");
  return createRule(db, orgId, {
    title: t.title,
    text: t.text,
    category: t.category,
    severity: t.severity,
    instructions: t.instructions,
    paths: [...t.paths],
    repoId: input.repoId ?? null,
    source: "template",
    createdBy: input.createdBy ?? null,
  });
}

/** Active, enabled rules that apply to a repo: org-wide ones plus the repo's own. */
export async function activeRulesForRepo(db: Db, orgId: string, repoId: number): Promise<ReviewRule[]> {
  const rows = await db
    .select()
    .from(rules)
    .where(scoped(rules, orgId, eq(rules.status, "active"), eq(rules.enabled, true), or(isNull(rules.repoId), eq(rules.repoId, repoId))))
    .orderBy(rules.id);
  return rows.map((r) => ({
    id: `rule:${r.id}`,
    text: r.text,
    paths: r.paths,
    scope: r.repoId ? "repo" : "org",
    category: r.category,
    severity: r.severity,
    ...(r.instructions.trim() ? { instructions: r.instructions } : {}),
  }));
}

/** The `findings.rule_id` value of a dashboard rule. */
export function ruleRef(ruleId: number): string {
  return `rule:${ruleId}`;
}

/** Published findings that cite each rule ("Findings from this rule"). Rules without findings are absent. */
export async function ruleFindingCounts(db: Db, orgId: string, ruleIds: number[]): Promise<Map<number, number>> {
  if (!ruleIds.length) return new Map();
  const rows = await db
    .select({ ruleId: findings.ruleId, n: count() })
    .from(findings)
    .where(scoped(findings, orgId, eq(findings.visibility, "published"), inArray(findings.ruleId, ruleIds.map(ruleRef))))
    .groupBy(findings.ruleId);
  const out = new Map<number, number>();
  for (const r of rows) {
    const id = Number(r.ruleId?.slice("rule:".length));
    if (Number.isSafeInteger(id)) out.set(id, Number(r.n));
  }
  return out;
}

export interface PathPreview {
  /** Indexed files the globs match (at most `limit` per repository are counted). */
  files: number;
  /** Repositories searched. */
  repos: number;
  /** A few matching paths, `repo:path` when several repositories were searched. */
  sample: string[];
  /** True when a repository hit the per-repository limit, so `files` is a lower bound. */
  capped: boolean;
}

const GLOB_CHARS = /[*?[\]{}!]/;
const PREVIEW_REPOS = 25;

/**
 * Live "matches N files" preview for a rule's path globs (R6.11), over the indexed `files` table: one repository
 * for a repository rule, or the org's repositories (up to 25) for an org-wide rule. Matching uses the same glob
 * semantics as the engine (`globMatch`).
 */
export async function previewRulePaths(
  db: Db,
  orgId: string,
  input: { repoId: number | null; paths: string[]; limit?: number },
): Promise<PathPreview> {
  const globs = cleanPaths(input.paths).slice(0, MAX_RULE_PATHS);
  const limit = Math.min(Math.max(input.limit ?? 1000, 1), 5000);
  const targets = await db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(repos)
    .where(scoped(repos, orgId, input.repoId !== null ? eq(repos.id, input.repoId) : eq(repos.archived, false)))
    .orderBy(repos.fullName)
    .limit(PREVIEW_REPOS);
  const preview: PathPreview = { files: 0, repos: targets.length, sample: [], capped: false };
  for (const repo of targets) {
    const scope = { orgId, repoId: repo.id };
    const matched = new Set<string>();
    if (!globs.length) {
      const [row] = await db.select({ n: count() }).from(files).where(scoped(files, orgId, eq(files.repoId, repo.id)));
      const n = Number(row?.n ?? 0);
      preview.files += n;
      const first = await db.select({ path: files.path }).from(files).where(scoped(files, orgId, eq(files.repoId, repo.id))).orderBy(files.path).limit(5);
      for (const f of first) matched.add(f.path);
    } else {
      for (const g of globs) {
        if (GLOB_CHARS.test(g)) {
          for (const f of await searchPaths(db, scope, g, { limit })) matched.add(f.path);
        } else {
          const exact = await db.select({ path: files.path }).from(files).where(scoped(files, orgId, eq(files.repoId, repo.id), eq(files.path, g)));
          for (const f of exact) matched.add(f.path);
        }
        if (matched.size >= limit) break;
      }
      const confirmed = [...matched].filter((p) => globMatch(globs, p));
      matched.clear();
      for (const p of confirmed) matched.add(p);
      if (matched.size >= limit) preview.capped = true;
      preview.files += Math.min(matched.size, limit);
    }
    for (const p of [...matched].sort().slice(0, Math.max(0, 5 - preview.sample.length))) {
      preview.sample.push(targets.length > 1 ? `${repo.fullName}:${p}` : p);
    }
  }
  return preview;
}

const previewQuerySchema = z.object({
  repoId: z.coerce.number().int().positive().nullable(),
  paths: z.array(z.string().max(200)).max(MAX_RULE_PATHS),
});

/**
 * `GET /api/rules/preview?repoId=<id>&paths=<globs, comma or newline separated>` (R6.11): how many indexed files
 * a rule's globs match. The org comes from the session; a repository of another org is a 404.
 */
export function createRulePreviewHandler(factory: () => { db: Db; clock: SessionClock }) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const auth = await authorizeRequest(deps, req);
    if (!auth.ok) return auth.response;
    const params = new URL(req.url).searchParams;
    const repoRaw = params.get("repoId")?.trim();
    const parsed = previewQuerySchema.safeParse({ repoId: repoRaw ? repoRaw : null, paths: parsePathsInput(params.get("paths") ?? "") });
    const headers = { "cache-control": "no-store" };
    if (!parsed.success) return Response.json({ error: "invalid_query" }, { status: 400, headers });
    const { repoId, paths } = parsed.data;
    if (repoId !== null) {
      const [repo] = await deps.db.select({ id: repos.id }).from(repos).where(scoped(repos, auth.ctx.orgId, eq(repos.id, repoId)));
      if (!repo) return Response.json({ error: "not_found" }, { status: 404, headers });
    }
    return Response.json(await previewRulePaths(deps.db, auth.ctx.orgId, { repoId, paths }), { headers });
  };
}

export function parsePathsInput(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- the dashboard rule form ----------------------------------------------------------------------------------

const formSchema = ruleFieldsSchema.extend({
  title: z.string().trim().min(3, "Give the rule a short title.").max(120, "Keep the title under 120 characters."),
  scope: z.enum(["org", "repo"], { message: "Pick a scope." }),
  repoId: z.number().int().positive().nullable(),
});

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function formValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["ruleId", "title", "text", "category", "severity", "enabled", "instructions", "paths", "scope", "repoId"]) out[key] = str(form, key);
  return out;
}

/** Reads the create/edit rule form into validated rule fields, or field errors. */
export function parseRuleForm(form: FormData): { input: RulePatch & { text: string }; errors?: undefined } | { input?: undefined; errors: RuleFormErrors } {
  const repoRaw = str(form, "repoId").trim();
  const scope = str(form, "scope") || (repoRaw ? "repo" : "org");
  const repoId = scope === "repo" && repoRaw ? Number(repoRaw) : null;
  const parsed = formSchema.safeParse({
    title: str(form, "title"),
    text: str(form, "text"),
    category: str(form, "category") || "rules",
    severity: str(form, "severity") || "medium",
    enabled: str(form, "enabled") !== "false",
    instructions: str(form, "instructions"),
    paths: parsePathsInput(str(form, "paths")),
    scope,
    repoId: repoId !== null && Number.isSafeInteger(repoId) ? repoId : repoId === null ? null : -1,
  });
  const errors: RuleFormErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form") as keyof RuleFormErrors;
      errors[key] ??= key === "repoId" ? "Pick a repository." : issue.message;
    }
    return { errors };
  }
  if (parsed.data.scope === "repo" && parsed.data.repoId === null) return { errors: { repoId: "Pick a repository for a repository rule." } };
  const d = parsed.data;
  return {
    input: { title: d.title, text: d.text, category: d.category, severity: d.severity, enabled: d.enabled, instructions: d.instructions, paths: d.paths, repoId: d.repoId },
  };
}

/**
 * The server-action body behind the rule form: checks the role, validates, and creates the rule (or updates
 * `ruleId`). `ctx` comes from the session; the rule and repository must belong to `ctx.orgId`.
 */
export async function saveRuleForm(db: Db, ctx: { orgId: string; userId: string; role: Role }, form: FormData): Promise<RuleFormState> {
  if (!can(ctx.role, "rules.manage")) return { status: "forbidden", errors: {}, message: "Only owners and admins can change rules." };
  const parsed = parseRuleForm(form);
  if (parsed.errors) return { status: "invalid", errors: parsed.errors, message: "Some fields need attention.", values: formValues(form) };
  const ruleIdRaw = str(form, "ruleId").trim();
  try {
    if (ruleIdRaw) {
      const ruleId = Number(ruleIdRaw);
      const row = Number.isSafeInteger(ruleId) ? await updateRule(db, ctx.orgId, ruleId, parsed.input) : undefined;
      if (!row) return { status: "not_found", errors: {}, message: "That rule no longer exists." };
      return { status: "saved", errors: {}, message: "Rule saved.", ruleId: row.id };
    }
    const row = await createRule(db, ctx.orgId, { ...parsed.input, createdBy: ctx.userId });
    return { status: "saved", errors: {}, message: "Rule created.", ruleId: row.id };
  } catch (err) {
    if (err instanceof RuleValidationError) {
      return { status: "invalid", errors: { form: err.message }, message: err.message, values: formValues(form) };
    }
    throw err;
  }
}

/** Org-wide rules and the repository's own, used to show what applies to one repository. */
export function appliesToRepo(rule: Pick<RuleRow, "repoId">, repoId: number): boolean {
  return rule.repoId === null || rule.repoId === repoId;
}

/** Counts of the org's rules by status, for the Rules page tabs. */
export async function ruleStatusCounts(db: Db, orgId: string): Promise<Record<RuleStatus, number>> {
  const rows = await db.select({ status: rules.status, n: count() }).from(rules).where(scoped(rules, orgId)).groupBy(rules.status);
  const out: Record<RuleStatus, number> = { active: 0, candidate: 0, rejected: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

