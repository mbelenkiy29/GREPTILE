/**
 * Finding feedback (R6.10): useful, not useful, resolved, won't fix, and false positive, from the dashboard, the
 * API, MCP, the CLI, and GitHub. Every function is tenant-scoped: the finding must belong to `orgId`.
 *
 * - `resolved`, `wont_fix`, and `false_positive` also change the finding's status (resolution `user`).
 * - `useful`, `not_useful`, and `false_positive` feed the learned preferences (pattern and category, see
 *   `lib/learning/preferences.ts`).
 * - A signed-in user's useful / not-useful vote replaces their previous one; GitHub feedback is deduplicated by the
 *   reaction or comment id.
 */
import { and, count, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { findingFeedback as feedbackTable, findings, reviews, users } from "@/lib/db/schema";
import {
  recomputeCategoryPreference,
  recordPatternSignal,
  reversePatternSignal,
  type PatternSignalInput,
} from "@/lib/learning/preferences";
import { findingCounts, type FindingRow } from "./findings";
import { scoped } from "./tenant";

export const FEEDBACK_KINDS = ["useful", "not_useful", "resolved", "wont_fix", "false_positive"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_SOURCES = ["dashboard", "api", "mcp", "cli", "github_reaction", "github_reply", "github_command"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];
export type FeedbackRow = typeof feedbackTable.$inferSelect;

/** Kinds that set the finding's status, and the status each sets. */
const STATUS_FOR: Partial<Record<FeedbackKind, "resolved" | "wont_fix" | "false_positive">> = {
  resolved: "resolved",
  wont_fix: "wont_fix",
  false_positive: "false_positive",
};
/** Kinds that teach the learned preferences, with their sentiment. */
const SENTIMENT: Partial<Record<FeedbackKind, 1 | -1>> = { useful: 1, not_useful: -1, false_positive: -1 };
const VOTES: readonly FeedbackKind[] = ["useful", "not_useful"];

export class FeedbackError extends Error {}

export interface SubmitFeedbackInput {
  orgId: string;
  findingId: number;
  /** Signed-in user (dashboard, API, MCP, CLI). */
  userId?: string | null;
  /** GitHub login (reactions, replies, commands). */
  externalAuthor?: string | null;
  /** GitHub reaction or comment id; feedback with the same source and id is recorded once. */
  externalId?: number | null;
  source: FeedbackSource;
  kind: FeedbackKind;
  note?: string | null;
  now?: Date;
}

export type FeedbackCounts = Record<FeedbackKind, number>;

export interface FeedbackResult {
  feedbackId: number;
  /** The same feedback was already recorded (nothing changed). */
  duplicate: boolean;
  finding: { id: number; status: FindingRow["status"]; resolution: FindingRow["resolution"] };
  counts: FeedbackCounts;
  /** The learned pattern the feedback was folded into, if any. */
  patternId: number | null;
}

const LEARNING_SOURCE: Record<FeedbackSource, PatternSignalInput["source"]> = {
  dashboard: "feedback",
  api: "feedback",
  mcp: "feedback",
  cli: "feedback",
  github_reaction: "feedback",
  github_reply: "reply",
  github_command: "command",
};

async function loadFinding(db: Db, orgId: string, findingId: number): Promise<FindingRow> {
  const [f] = await db.select().from(findings).where(scoped(findings, orgId, eq(findings.id, findingId), ne(findings.visibility, "rejected")));
  if (!f) throw new FeedbackError("Finding not found.");
  return f;
}

/** Feedback counts of one finding, by kind. */
export async function feedbackCounts(db: Db, orgId: string, findingId: number): Promise<FeedbackCounts> {
  const rows = await db
    .select({ kind: feedbackTable.kind, n: count() })
    .from(feedbackTable)
    .where(scoped(feedbackTable, orgId, eq(feedbackTable.findingId, findingId)))
    .groupBy(feedbackTable.kind);
  const out = Object.fromEntries(FEEDBACK_KINDS.map((k) => [k, 0])) as FeedbackCounts;
  for (const r of rows) out[r.kind] = Number(r.n);
  return out;
}

/** Keeps the PR review's open / resolved aggregates in step after a status change. */
async function refreshReviewCounts(db: Db, orgId: string, reviewId: number) {
  const counts = await findingCounts(db, orgId, reviewId);
  await db.update(reviews).set({ openFindings: counts.open, resolvedFindings: counts.resolved }).where(scoped(reviews, orgId, eq(reviews.id, reviewId)));
}

/** Removes one feedback row and takes back what it taught (inside the caller's transaction). */
async function removeFeedback(db: Db, orgId: string, row: FeedbackRow, finding: FindingRow, now: Date) {
  await db.delete(feedbackTable).where(scoped(feedbackTable, orgId, eq(feedbackTable.id, row.id)));
  const sentiment = SENTIMENT[row.kind];
  if (sentiment && row.patternId !== null && row.countsForLearning) await reversePatternSignal(db, orgId, row.patternId, sentiment);
  const status = STATUS_FOR[row.kind];
  if (status && finding.status === status && finding.resolution === "user") {
    // Reopen unless other feedback still asks for this status.
    const [other] = await db
      .select({ id: feedbackTable.id })
      .from(feedbackTable)
      .where(scoped(feedbackTable, orgId, eq(feedbackTable.findingId, finding.id), eq(feedbackTable.kind, row.kind)))
      .limit(1);
    if (!other) {
      await db
        .update(findings)
        .set({ status: "open", resolution: null, resolvedAt: null, resolvedSha: null })
        .where(scoped(findings, orgId, eq(findings.id, finding.id)));
      finding.status = "open";
      finding.resolution = null;
      await refreshReviewCounts(db, orgId, finding.reviewId);
    }
  }
  if (sentiment) await recomputeCategoryPreference(db, orgId, finding.repoId, finding.category, now);
}

/**
 * Records feedback on a finding (R6.10) and applies it: status changes for resolved / won't fix / false positive,
 * learned preferences for useful / not useful / false positive. Idempotent for repeated GitHub signals and for a
 * user repeating the same feedback.
 */
export async function submitFindingFeedback(db: Db, input: SubmitFeedbackInput): Promise<FeedbackResult> {
  if (!FEEDBACK_KINDS.includes(input.kind)) throw new FeedbackError(`Unknown feedback kind ${String(input.kind)}.`);
  if (!FEEDBACK_SOURCES.includes(input.source)) throw new FeedbackError(`Unknown feedback source ${String(input.source)}.`);
  const userId = input.userId ?? null;
  const externalAuthor = input.externalAuthor?.trim() || null;
  if (!userId && !externalAuthor) throw new FeedbackError("Feedback needs a user or an external author.");
  const note = input.note?.trim().slice(0, 4000) || null;
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const finding = await loadFinding(tx, input.orgId, input.findingId);

    // A user's new useful / not-useful vote replaces the opposite one.
    if (userId && VOTES.includes(input.kind)) {
      const previous = await tx
        .select()
        .from(feedbackTable)
        .where(
          scoped(
            feedbackTable,
            input.orgId,
            eq(feedbackTable.findingId, finding.id),
            eq(feedbackTable.userId, userId),
            inArray(feedbackTable.kind, VOTES.filter((k) => k !== input.kind) as FeedbackKind[]),
          ),
        );
      for (const p of previous) await removeFeedback(tx, input.orgId, p, finding, now);
    }

    const [inserted] = await tx
      .insert(feedbackTable)
      .values({
        orgId: input.orgId,
        findingId: finding.id,
        userId,
        externalAuthor,
        externalId: input.externalId ?? null,
        source: input.source,
        kind: input.kind,
        note,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(feedbackTable)
        .where(
          scoped(
            feedbackTable,
            input.orgId,
            eq(feedbackTable.findingId, finding.id),
            userId && input.externalId == null
              ? and(eq(feedbackTable.userId, userId), eq(feedbackTable.kind, input.kind))
              : and(eq(feedbackTable.source, input.source), eq(feedbackTable.externalId, input.externalId ?? -1)),
          ),
        )
        .limit(1);
      return {
        feedbackId: existing?.id ?? 0,
        duplicate: true,
        finding: { id: finding.id, status: finding.status, resolution: finding.resolution },
        counts: await feedbackCounts(tx, input.orgId, finding.id),
        patternId: existing?.patternId ?? null,
      };
    }

    let patternId: number | null = null;
    const sentiment = SENTIMENT[input.kind];
    if (sentiment) {
      patternId = await recordPatternSignal(tx, {
        orgId: input.orgId,
        repoId: finding.repoId,
        category: finding.category,
        title: finding.title,
        path: finding.path,
        sentiment,
        source: LEARNING_SOURCE[input.source],
        at: now,
      });
      await tx.update(feedbackTable).set({ patternId }).where(scoped(feedbackTable, input.orgId, eq(feedbackTable.id, inserted.id)));
    }

    const status = STATUS_FOR[input.kind];
    let { status: currentStatus, resolution } = finding;
    if (status && currentStatus !== status) {
      const [updated] = await tx
        .update(findings)
        .set({ status, resolution: "user", resolvedAt: now })
        .where(scoped(findings, input.orgId, eq(findings.id, finding.id)))
        .returning({ status: findings.status, resolution: findings.resolution });
      currentStatus = updated!.status;
      resolution = updated!.resolution;
      await refreshReviewCounts(tx, input.orgId, finding.reviewId);
    }
    if (sentiment) await recomputeCategoryPreference(tx, input.orgId, finding.repoId, finding.category, now);

    return {
      feedbackId: inserted.id,
      duplicate: false,
      finding: { id: finding.id, status: currentStatus, resolution },
      counts: await feedbackCounts(tx, input.orgId, finding.id),
      patternId,
    };
  });
}

/**
 * Takes feedback back: deletes it, reverses what it taught, and reopens the finding when it had set its status and
 * nothing else asks for that status. With `userId`, only that user's own feedback can be retracted.
 */
export async function retractFeedback(
  db: Db,
  input: { orgId: string; feedbackId: number; userId?: string; now?: Date },
): Promise<{ retracted: boolean; finding?: FeedbackResult["finding"]; counts?: FeedbackCounts }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(feedbackTable)
      .where(
        scoped(feedbackTable, input.orgId, eq(feedbackTable.id, input.feedbackId), input.userId !== undefined ? eq(feedbackTable.userId, input.userId) : undefined),
      );
    if (!row) return { retracted: false };
    const finding = await loadFinding(tx, input.orgId, row.findingId);
    await removeFeedback(tx, input.orgId, row, finding, now);
    return {
      retracted: true,
      finding: { id: finding.id, status: finding.status, resolution: finding.resolution },
      counts: await feedbackCounts(tx, input.orgId, finding.id),
    };
  });
}

export interface FindingFeedbackItem {
  id: number;
  kind: FeedbackKind;
  source: FeedbackSource;
  userId: string | null;
  userName: string | null;
  externalAuthor: string | null;
  note: string | null;
  createdAt: Date;
}

/** Feedback on one finding, newest first (empty for another org's finding). */
export async function findingFeedback(db: Db, orgId: string, findingId: number): Promise<FindingFeedbackItem[]> {
  const rows = await db
    .select({ f: feedbackTable, userName: users.name, userLogin: users.githubLogin })
    .from(feedbackTable)
    .leftJoin(users, eq(feedbackTable.userId, users.id))
    .where(scoped(feedbackTable, orgId, eq(feedbackTable.findingId, findingId)))
    .orderBy(desc(feedbackTable.createdAt), desc(feedbackTable.id));
  return rows.map(({ f, userName, userLogin }) => ({
    id: f.id,
    kind: f.kind,
    source: f.source,
    userId: f.userId,
    userName: userName ?? userLogin ?? null,
    externalAuthor: f.externalAuthor,
    note: f.note,
    createdAt: f.createdAt,
  }));
}

export interface FeedbackBreakdown {
  useful: number;
  notUseful: number;
  falsePositive: number;
  resolved: number;
  wontFix: number;
  /** useful / (useful + not useful + false positive), or null without any of those. */
  acceptanceRate: number | null;
}

function emptyBreakdown(): FeedbackBreakdown {
  return { useful: 0, notUseful: 0, falsePositive: 0, resolved: 0, wontFix: 0, acceptanceRate: null };
}

function add(b: FeedbackBreakdown, kind: FeedbackKind, n: number) {
  if (kind === "useful") b.useful += n;
  else if (kind === "not_useful") b.notUseful += n;
  else if (kind === "false_positive") b.falsePositive += n;
  else if (kind === "resolved") b.resolved += n;
  else b.wontFix += n;
}

function finish(b: FeedbackBreakdown): FeedbackBreakdown {
  const judged = b.useful + b.notUseful + b.falsePositive;
  return { ...b, acceptanceRate: judged ? b.useful / judged : null };
}

export interface FeedbackSummary {
  total: FeedbackBreakdown;
  byCategory: (FeedbackBreakdown & { category: string })[];
  byAgent: (FeedbackBreakdown & { agent: string })[];
}

/** Feedback totals and acceptance rates for the org (or one repository), overall, per category, and per agent. */
export async function feedbackSummary(db: Db, orgId: string, opts: { repoId?: number; since?: Date } = {}): Promise<FeedbackSummary> {
  const rows = await db
    .select({ kind: feedbackTable.kind, category: findings.category, agent: findings.agent, n: count() })
    .from(feedbackTable)
    .innerJoin(findings, eq(feedbackTable.findingId, findings.id))
    .where(
      and(
        scoped(feedbackTable, orgId, opts.since ? gte(feedbackTable.createdAt, opts.since) : undefined),
        eq(findings.orgId, orgId),
        opts.repoId !== undefined ? eq(findings.repoId, opts.repoId) : undefined,
      ),
    )
    .groupBy(feedbackTable.kind, findings.category, findings.agent);
  const total = emptyBreakdown();
  const byCategory = new Map<string, FeedbackBreakdown>();
  const byAgent = new Map<string, FeedbackBreakdown>();
  for (const r of rows) {
    const n = Number(r.n);
    add(total, r.kind, n);
    if (!byCategory.has(r.category)) byCategory.set(r.category, emptyBreakdown());
    add(byCategory.get(r.category)!, r.kind, n);
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, emptyBreakdown());
    add(byAgent.get(r.agent)!, r.kind, n);
  }
  return {
    total: finish(total),
    byCategory: [...byCategory].map(([category, b]) => ({ category, ...finish(b) })).sort((a, b) => a.category.localeCompare(b.category)),
    byAgent: [...byAgent].map(([agent, b]) => ({ agent, ...finish(b) })).sort((a, b) => a.agent.localeCompare(b.agent)),
  };
}

/** Feedback rows recorded from GitHub reactions on a finding's comment, for reconciling removed reactions. */
export async function githubReactionFeedback(db: Db, orgId: string, findingIds: readonly number[]): Promise<FeedbackRow[]> {
  if (!findingIds.length) return [];
  return db
    .select()
    .from(feedbackTable)
    .where(scoped(feedbackTable, orgId, eq(feedbackTable.source, "github_reaction"), inArray(feedbackTable.findingId, [...findingIds])));
}

const formInt = z.coerce.number().int().positive();

/** A feedback form from the dashboard (`findingId`, `kind`, optional `note`). */
export const feedbackFormSchema = z.object({
  findingId: formInt,
  kind: z.enum(FEEDBACK_KINDS),
  note: z.string().max(4000).optional(),
});

/** Reads a dashboard feedback form; throws {@link FeedbackError} when it is malformed. */
export function parseFeedbackForm(formData: FormData): z.infer<typeof feedbackFormSchema> {
  const note = formData.get("note");
  const parsed = feedbackFormSchema.safeParse({
    findingId: formData.get("findingId"),
    kind: formData.get("kind"),
    ...(typeof note === "string" && note.trim() ? { note } : {}),
  });
  if (!parsed.success) throw new FeedbackError("Invalid feedback.");
  return parsed.data;
}

