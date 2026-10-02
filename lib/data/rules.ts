import { desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { repos, rules } from "@/lib/db/schema";
import type { ReviewRule } from "@/lib/rules";
import { scoped } from "./tenant";

export type RuleRow = typeof rules.$inferSelect;
type RuleStatus = RuleRow["status"];

export class RuleValidationError extends Error {}

function cleanPaths(paths: string[] | undefined) {
  return [...new Set((paths ?? []).map((p) => p.trim()).filter(Boolean))];
}

async function assertRepoInOrg(db: Db, orgId: string, repoId: number | null | undefined) {
  if (repoId == null) return;
  const [r] = await db.select({ id: repos.id }).from(repos).where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!r) throw new RuleValidationError("Repository not found in this organization.");
}

export async function createRule(
  db: Db,
  orgId: string,
  input: {
    text: string;
    repoId?: number | null;
    paths?: string[];
    status?: RuleStatus;
    source?: string;
    rationale?: string | null;
    evidence?: RuleRow["evidence"];
    createdBy?: string | null;
  },
): Promise<RuleRow> {
  const text = input.text.trim();
  if (text.length < 5 || text.length > 2000) throw new RuleValidationError("A rule must be 5–2000 characters.");
  await assertRepoInOrg(db, orgId, input.repoId);
  const [row] = await db
    .insert(rules)
    .values({
      orgId,
      repoId: input.repoId ?? null,
      text,
      paths: cleanPaths(input.paths),
      status: input.status ?? "active",
      source: input.source ?? "dashboard",
      rationale: input.rationale ?? null,
      evidence: input.evidence ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row!;
}

export async function listRules(db: Db, orgId: string, opts: { status?: RuleStatus[]; repoId?: number } = {}) {
  return db
    .select({ rule: rules, repoFullName: repos.fullName })
    .from(rules)
    .leftJoin(repos, eq(rules.repoId, repos.id))
    .where(
      scoped(
        rules,
        orgId,
        opts.status ? inArray(rules.status, opts.status) : undefined,
        opts.repoId ? eq(rules.repoId, opts.repoId) : undefined,
      ),
    )
    .orderBy(desc(rules.createdAt), desc(rules.id));
}

export async function updateRule(
  db: Db,
  orgId: string,
  ruleId: number,
  patch: { text?: string; paths?: string[]; repoId?: number | null; status?: RuleStatus },
) {
  if (patch.text !== undefined && (patch.text.trim().length < 5 || patch.text.length > 2000)) {
    throw new RuleValidationError("A rule must be 5–2000 characters.");
  }
  await assertRepoInOrg(db, orgId, patch.repoId);
  const [row] = await db
    .update(rules)
    .set({
      ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
      ...(patch.paths !== undefined ? { paths: cleanPaths(patch.paths) } : {}),
      ...(patch.repoId !== undefined ? { repoId: patch.repoId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    })
    .where(scoped(rules, orgId, eq(rules.id, ruleId)))
    .returning();
  return row;
}

export async function deleteRule(db: Db, orgId: string, ruleId: number) {
  const rows = await db.delete(rules).where(scoped(rules, orgId, eq(rules.id, ruleId))).returning({ id: rules.id });
  return rows.length > 0;
}

/** Active rules that apply to a repo: org-wide ones plus the repo's own. */
export async function activeRulesForRepo(db: Db, orgId: string, repoId: number): Promise<ReviewRule[]> {
  const rows = await db
    .select()
    .from(rules)
    .where(scoped(rules, orgId, eq(rules.status, "active"), or(isNull(rules.repoId), eq(rules.repoId, repoId))))
    .orderBy(rules.id);
  return rows.map((r) => ({ id: `rule:${r.id}`, text: r.text, paths: r.paths, scope: r.repoId ? "repo" : "org" }));
}

export function parsePathsInput(raw: string): string[] {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

