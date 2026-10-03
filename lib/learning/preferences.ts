/**
 * Learned preferences (R2.4, R6.10): structured, inspectable, resettable conventions inferred from feedback on
 * OpenReview findings, stored in `learned_patterns`.
 *
 * - Pattern preferences match findings by category and title. Feedback on a finding folds into the closest pattern
 *   of its category (or starts one); the net score decides the signal (`suppress` at -2, `boost` at +2).
 * - Category preferences cover every finding of a category in a repository. Over the last {@link CATEGORY_WINDOW}
 *   findings of the category that got feedback, an acceptance rate below 25% adds a `suppress` preference that raises
 *   the category's minimum confidence by {@link CATEGORY_CONFIDENCE_DELTA} (it never blocks the category); a rate of
 *   75% or more adds a `boost`.
 * - "Ignore this pattern" commands and people's own entries are pinned (`userEdited`): later feedback and resets
 *   leave them alone unless a reset asks for everything.
 *
 * The review engine reads all of them through {@link learnedPreferencesForReview}.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { findingFeedback, findings, learnedPatterns, repos } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import type { LearnedPreference } from "@/lib/engine/types";
import { similarity } from "@/lib/review/text";

/** Score at or below which a pattern is suppressed, and at or above which it is prioritized. */
export const SUPPRESS_AT = -2;
export const BOOST_AT = 2;
/** Title similarity at which feedback joins an existing pattern. */
export const PATTERN_MATCH = 0.5;

/** Findings with feedback considered per category. */
export const CATEGORY_WINDOW = 30;
/** Findings with a clear verdict needed before a category preference is formed. */
export const MIN_CATEGORY_SAMPLE = 5;
export const CATEGORY_SUPPRESS_BELOW = 0.25;
export const CATEGORY_BOOST_AT = 0.75;
export const CATEGORY_CONFIDENCE_DELTA = 0.15;

export type PreferenceRow = typeof learnedPatterns.$inferSelect;
export type PreferenceSignal = PreferenceRow["signal"];
export type PreferenceSource = PreferenceRow["source"];

export function signalFor(positive: number, negative: number): PreferenceSignal {
  const score = positive - negative;
  if (score <= SUPPRESS_AT) return "suppress";
  if (score >= BOOST_AT) return "boost";
  return "neutral";
}

function patternSimilarity(p: Pick<PreferenceRow, "description" | "examples">, title: string): number {
  return Math.max(similarity(p.description, title), ...p.examples.map((e) => similarity(e.title, title)));
}

export interface PatternSignalInput {
  orgId: string;
  repoId: number;
  category: string;
  title: string;
  path: string;
  /** 1 accepts the finding, -1 rejects it. */
  sentiment: 1 | -1;
  source: Exclude<PreferenceSource, "human_rule">;
  at?: Date;
}

/**
 * Folds one piece of feedback into the matching pattern of the repository (creating one if none is close enough)
 * and updates its signal unless a person pinned it. Returns the pattern id.
 */
export async function recordPatternSignal(db: Db, input: PatternSignalInput): Promise<number> {
  const at = input.at ?? new Date();
  const candidates = await db
    .select()
    .from(learnedPatterns)
    .where(
      scoped(
        learnedPatterns,
        input.orgId,
        eq(learnedPatterns.repoId, input.repoId),
        eq(learnedPatterns.category, input.category),
        eq(learnedPatterns.kind, "pattern"),
      ),
    );
  const match = candidates
    .map((p) => ({ p, sim: patternSimilarity(p, input.title) }))
    .filter((x) => x.sim >= PATTERN_MATCH)
    .sort((a, b) => b.sim - a.sim || a.p.id - b.p.id)[0]?.p;

  const positive = (match?.positive ?? 0) + (input.sentiment > 0 ? 1 : 0);
  const negative = (match?.negative ?? 0) + (input.sentiment < 0 ? 1 : 0);
  if (!match) {
    const [row] = await db
      .insert(learnedPatterns)
      .values({
        orgId: input.orgId,
        repoId: input.repoId,
        scope: "repo",
        kind: "pattern",
        source: input.source,
        category: input.category,
        description: input.title,
        positive,
        negative,
        signal: signalFor(positive, negative),
        examples: [{ title: input.title, path: input.path }],
        evidenceCount: 1,
        lastSignalAt: at,
      })
      .returning({ id: learnedPatterns.id });
    return row!.id;
  }
  const examples = match.examples.some((e) => e.title === input.title)
    ? match.examples
    : [...match.examples, { title: input.title, path: input.path }].slice(-10);
  await db
    .update(learnedPatterns)
    .set({
      positive,
      negative,
      examples,
      evidenceCount: sql`${learnedPatterns.evidenceCount} + 1`,
      lastSignalAt: at,
      ...(match.userEdited ? {} : { signal: signalFor(positive, negative) }),
    })
    .where(scoped(learnedPatterns, input.orgId, eq(learnedPatterns.id, match.id)));
  return match.id;
}

/** Takes back one signal from a pattern (feedback retracted or replaced). */
export async function reversePatternSignal(db: Db, orgId: string, patternId: number, sentiment: 1 | -1): Promise<void> {
  const [p] = await db.select().from(learnedPatterns).where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, patternId)));
  if (!p) return;
  const positive = Math.max(0, p.positive - (sentiment > 0 ? 1 : 0));
  const negative = Math.max(0, p.negative - (sentiment < 0 ? 1 : 0));
  await db
    .update(learnedPatterns)
    .set({
      positive,
      negative,
      evidenceCount: Math.max(0, p.evidenceCount - 1),
      ...(p.userEdited ? {} : { signal: signalFor(positive, negative) }),
    })
    .where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, patternId)));
}

export interface CategoryStats {
  accepted: number;
  rejected: number;
  /** accepted / (accepted + rejected), or null without any verdict. */
  rate: number | null;
}

/**
 * Acceptance of a category in a repository over its last {@link CATEGORY_WINDOW} findings with feedback that still
 * counts for learning. A finding is accepted when its useful votes outnumber its not-useful and false-positive
 * ones, rejected when they are outnumbered; ties count for neither.
 */
export async function categoryStats(db: Db, orgId: string, repoId: number, category: string): Promise<CategoryStats> {
  const positive = sql<number>`count(*) filter (where ${findingFeedback.kind} = 'useful')`;
  const negative = sql<number>`count(*) filter (where ${findingFeedback.kind} in ('not_useful', 'false_positive'))`;
  const rows = await db
    .select({ findingId: findingFeedback.findingId, positive, negative, last: sql<Date>`max(${findingFeedback.createdAt})` })
    .from(findingFeedback)
    .innerJoin(findings, eq(findingFeedback.findingId, findings.id))
    .where(
      and(
        scoped(findingFeedback, orgId, eq(findingFeedback.countsForLearning, true), inArray(findingFeedback.kind, ["useful", "not_useful", "false_positive"])),
        eq(findings.orgId, orgId),
        eq(findings.repoId, repoId),
        eq(findings.category, category),
      ),
    )
    .groupBy(findingFeedback.findingId)
    .orderBy(desc(sql`max(${findingFeedback.createdAt})`), desc(findingFeedback.findingId))
    .limit(CATEGORY_WINDOW);
  let accepted = 0;
  let rejected = 0;
  for (const r of rows) {
    const pos = Number(r.positive);
    const neg = Number(r.negative);
    if (pos > neg) accepted++;
    else if (neg > pos) rejected++;
  }
  const n = accepted + rejected;
  return { accepted, rejected, rate: n ? accepted / n : null };
}

function categoryDescription(category: string, stats: CategoryStats): string {
  const n = stats.accepted + stats.rejected;
  const pct = Math.round((stats.rate ?? 0) * 100);
  return `${category} findings: ${stats.accepted} of ${n} recent findings with feedback were useful (${pct}%)`;
}

/**
 * Re-derives a repository's category preference from its recent feedback (R6.10). Creates, updates, or removes the
 * preference; a pinned one keeps its signal and description and only gets fresh counts.
 */
export async function recomputeCategoryPreference(
  db: Db,
  orgId: string,
  repoId: number,
  category: string,
  now: Date = new Date(),
): Promise<PreferenceRow | null> {
  const stats = await categoryStats(db, orgId, repoId, category);
  const n = stats.accepted + stats.rejected;
  const desired: "suppress" | "boost" | null =
    n >= MIN_CATEGORY_SAMPLE && stats.rate !== null
      ? stats.rate < CATEGORY_SUPPRESS_BELOW
        ? "suppress"
        : stats.rate >= CATEGORY_BOOST_AT
          ? "boost"
          : null
      : null;
  const [existing] = await db
    .select()
    .from(learnedPatterns)
    .where(scoped(learnedPatterns, orgId, eq(learnedPatterns.repoId, repoId), eq(learnedPatterns.category, category), eq(learnedPatterns.kind, "category")));
  const counts = { positive: stats.accepted, negative: stats.rejected, evidenceCount: n, lastSignalAt: now };

  if (existing?.userEdited) {
    const [row] = await db.update(learnedPatterns).set(counts).where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, existing.id))).returning();
    return row ?? null;
  }
  if (!desired) {
    if (existing) await db.delete(learnedPatterns).where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, existing.id)));
    return null;
  }
  const values = {
    ...counts,
    signal: desired,
    description: categoryDescription(category, stats),
    confidenceDelta: desired === "suppress" ? CATEGORY_CONFIDENCE_DELTA : 0,
  };
  if (existing) {
    const [row] = await db.update(learnedPatterns).set(values).where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, existing.id))).returning();
    return row ?? null;
  }
  const [row] = await db
    .insert(learnedPatterns)
    .values({ orgId, repoId, scope: "repo", kind: "category", source: "feedback", category, examples: [], ...values })
    .onConflictDoUpdate({
      target: [learnedPatterns.repoId, learnedPatterns.category],
      targetWhere: sql`${learnedPatterns.kind} = 'category'`,
      set: values,
    })
    .returning();
  return row ?? null;
}

/**
 * An explicit "ignore this pattern" (R6.10, R6.17): a pinned suppress preference for findings like this one in the
 * repository. Reuses the closest existing pattern of the category when there is one.
 */
export async function ignorePatternPreference(
  db: Db,
  input: { orgId: string; repoId: number; category: string; title: string; path?: string; source?: "command" | "human_rule"; now?: Date },
): Promise<PreferenceRow> {
  const now = input.now ?? new Date();
  const title = input.title.trim();
  if (title.length < 3) throw new Error("Describe the pattern to ignore.");
  const candidates = await db
    .select()
    .from(learnedPatterns)
    .where(
      scoped(learnedPatterns, input.orgId, eq(learnedPatterns.repoId, input.repoId), eq(learnedPatterns.category, input.category), eq(learnedPatterns.kind, "pattern")),
    );
  const match = candidates
    .map((p) => ({ p, sim: patternSimilarity(p, title) }))
    .filter((x) => x.sim >= PATTERN_MATCH)
    .sort((a, b) => b.sim - a.sim || a.p.id - b.p.id)[0]?.p;
  const example = input.path ? [{ title, path: input.path }] : [];
  if (match) {
    const examples = match.examples.some((e) => e.title === title) ? match.examples : [...match.examples, ...example].slice(-10);
    const [row] = await db
      .update(learnedPatterns)
      .set({
        signal: "suppress",
        userEdited: true,
        source: input.source ?? "command",
        examples,
        negative: sql`${learnedPatterns.negative} + 1`,
        evidenceCount: sql`${learnedPatterns.evidenceCount} + 1`,
        lastSignalAt: now,
      })
      .where(scoped(learnedPatterns, input.orgId, eq(learnedPatterns.id, match.id)))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(learnedPatterns)
    .values({
      orgId: input.orgId,
      repoId: input.repoId,
      scope: "repo",
      kind: "pattern",
      source: input.source ?? "command",
      category: input.category,
      description: title,
      signal: "suppress",
      userEdited: true,
      negative: 1,
      evidenceCount: 1,
      examples: example,
      lastSignalAt: now,
    })
    .returning();
  return row!;
}

/** What the review engine is told about the team's preferences for one repository (its own plus org-wide ones). */
export async function learnedPreferencesForReview(db: Db, orgId: string, repoId: number): Promise<LearnedPreference[]> {
  const rows = await db
    .select()
    .from(learnedPatterns)
    .where(scoped(learnedPatterns, orgId, inArray(learnedPatterns.signal, ["suppress", "boost"]), or(isNull(learnedPatterns.repoId), eq(learnedPatterns.repoId, repoId))))
    .orderBy(learnedPatterns.id);
  return rows.map((r) => ({
    category: r.category,
    description: r.description,
    signal: r.signal,
    appliesTo: r.kind,
    ...(r.kind === "category" && r.signal === "suppress" ? { confidenceDelta: r.confidenceDelta } : {}),
  }));
}

/** A learned preference as the dashboard, API, and exports show it. */
export interface Preference {
  id: number;
  kind: "pattern" | "category";
  scope: "org" | "repo";
  repoId: number | null;
  repoFullName: string | null;
  category: string;
  description: string;
  signal: PreferenceSignal;
  source: PreferenceSource;
  /** Added to the category's minimum confidence while this preference is active. */
  confidenceDelta: number;
  positive: number;
  negative: number;
  evidenceCount: number;
  lastSignalAt: string | null;
  /** Set by a person (edited, created, or an explicit command): feedback and resets leave it alone. */
  pinned: boolean;
  examples: { title: string; path: string }[];
  createdAt: string;
  updatedAt: string;
}

function toPreference(r: PreferenceRow, repoFullName: string | null): Preference {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.repoId === null ? "org" : r.scope,
    repoId: r.repoId,
    repoFullName,
    category: r.category,
    description: r.description,
    signal: r.signal,
    source: r.source,
    confidenceDelta: r.kind === "category" && r.signal === "suppress" ? r.confidenceDelta : 0,
    positive: r.positive,
    negative: r.negative,
    evidenceCount: r.evidenceCount,
    lastSignalAt: r.lastSignalAt?.toISOString() ?? null,
    pinned: r.userEdited,
    examples: r.examples,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The org's learned preferences (optionally one repository's, including org-wide ones), active ones first. */
export async function listPreferences(db: Db, orgId: string, opts: { repoId?: number } = {}): Promise<Preference[]> {
  const rows = await db
    .select({ p: learnedPatterns, repoFullName: repos.fullName })
    .from(learnedPatterns)
    .leftJoin(repos, and(eq(learnedPatterns.repoId, repos.id), eq(repos.orgId, orgId)))
    .where(
      scoped(
        learnedPatterns,
        orgId,
        opts.repoId !== undefined ? or(isNull(learnedPatterns.repoId), eq(learnedPatterns.repoId, opts.repoId)) : undefined,
      ),
    )
    .orderBy(learnedPatterns.signal, learnedPatterns.kind, learnedPatterns.id);
  return rows.map((r) => toPreference(r.p, r.repoFullName));
}

export class PreferenceError extends Error {}

/**
 * A person's edit of a preference (description, signal, or a category's confidence increase). Any edit pins it, so
 * later feedback no longer changes its signal and resets keep it.
 */
export async function updatePreference(
  db: Db,
  orgId: string,
  id: number,
  patch: { description?: string; signal?: PreferenceSignal; confidenceDelta?: number },
): Promise<PreferenceRow | undefined> {
  if (patch.description !== undefined && patch.description.trim().length < 3) throw new PreferenceError("Description is too short.");
  if (patch.confidenceDelta !== undefined && !(patch.confidenceDelta >= 0 && patch.confidenceDelta <= 0.5)) {
    throw new PreferenceError("The confidence increase must be between 0 and 0.5.");
  }
  const set = {
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.signal !== undefined ? { signal: patch.signal } : {}),
    ...(patch.confidenceDelta !== undefined ? { confidenceDelta: patch.confidenceDelta } : {}),
  };
  if (!Object.keys(set).length) {
    const [row] = await db.select().from(learnedPatterns).where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, id)));
    return row;
  }
  const [row] = await db
    .update(learnedPatterns)
    .set({ ...set, userEdited: true })
    .where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, id)))
    .returning();
  return row;
}

/** A preference a person writes directly (e.g. from the dashboard or API); pinned from the start. */
export async function createPreference(
  db: Db,
  orgId: string,
  input: { repoId: number | null; category: string; description: string; signal: "suppress" | "boost"; kind?: "pattern" | "category" },
): Promise<PreferenceRow> {
  const description = input.description.trim();
  if (description.length < 3) throw new PreferenceError("Description is too short.");
  if (input.repoId !== null) {
    const [repo] = await db.select({ id: repos.id }).from(repos).where(scoped(repos, orgId, eq(repos.id, input.repoId)));
    if (!repo) throw new PreferenceError("Repository not found.");
  }
  const kind = input.kind ?? "pattern";
  if (kind === "category" && input.repoId === null) throw new PreferenceError("Category preferences belong to one repository.");
  const [row] = await db
    .insert(learnedPatterns)
    .values({
      orgId,
      repoId: input.repoId,
      scope: input.repoId === null ? "org" : "repo",
      kind,
      source: "human_rule",
      category: input.category,
      description,
      signal: input.signal,
      userEdited: true,
      confidenceDelta: kind === "category" && input.signal === "suppress" ? CATEGORY_CONFIDENCE_DELTA : 0,
    })
    .returning();
  return row!;
}

export async function deletePreference(db: Db, orgId: string, id: number): Promise<boolean> {
  const rows = await db.delete(learnedPatterns).where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, id))).returning({ id: learnedPatterns.id });
  return rows.length > 0;
}

/**
 * Forgets what was learned (R6.10): deletes the org's (or one repository's) preferences that no person pinned, or
 * every preference with `includePinned`, and stops the feedback behind them from counting toward future learning
 * (it still shows in feedback summaries). Returns how many preferences were deleted.
 */
export async function resetPreferences(db: Db, orgId: string, opts: { repoId?: number; includePinned?: boolean } = {}): Promise<{ deleted: number }> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(learnedPatterns)
      .where(
        scoped(
          learnedPatterns,
          orgId,
          opts.repoId !== undefined ? eq(learnedPatterns.repoId, opts.repoId) : undefined,
          opts.includePinned ? undefined : eq(learnedPatterns.userEdited, false),
        ),
      )
      .returning({ id: learnedPatterns.id });
    const inScope = tx
      .select({ id: findings.id })
      .from(findings)
      .where(scoped(findings, orgId, opts.repoId !== undefined ? eq(findings.repoId, opts.repoId) : undefined));
    await tx
      .update(findingFeedback)
      .set({ countsForLearning: false })
      .where(scoped(findingFeedback, orgId, eq(findingFeedback.countsForLearning, true), inArray(findingFeedback.findingId, inScope)));
    return { deleted: deleted.length };
  });
}

/** A reset form from the dashboard: optional `repoId`, and `includePinned` ("on") to delete pinned ones too. */
export function parseResetForm(formData: FormData): { repoId?: number; includePinned: boolean } {
  const raw = formData.get("repoId");
  const repoId = typeof raw === "string" && raw.trim() ? Number(raw) : undefined;
  if (repoId !== undefined && !(Number.isInteger(repoId) && repoId > 0)) throw new PreferenceError("Invalid repository.");
  const pinned = formData.get("includePinned");
  return { ...(repoId !== undefined ? { repoId } : {}), includePinned: pinned === "on" || pinned === "true" };
}

export interface PreferencesExport {
  version: 1;
  orgId: string;
  repoId: number | null;
  exportedAt: string;
  preferences: Preference[];
}

/** Every learned preference of the org (or one repository, with org-wide ones) as a JSON document. */
export async function exportPreferences(db: Db, orgId: string, opts: { repoId?: number; now?: Date } = {}): Promise<PreferencesExport> {
  return {
    version: 1,
    orgId,
    repoId: opts.repoId ?? null,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    preferences: await listPreferences(db, orgId, opts.repoId !== undefined ? { repoId: opts.repoId } : {}),
  };
}
