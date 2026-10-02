import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { commentFeedback, installations, learnedPatterns, repos, reviewComments, reviews } from "@/lib/db/schema";
import type { GitHost } from "@/lib/git/types";
import { scoped } from "@/lib/data/tenant";
import { similarity } from "@/lib/review/text";

/** Score at or below which a pattern is suppressed, and at or above which it is prioritized. */
export const SUPPRESS_AT = -2;
export const BOOST_AT = 2;
const MATCH = 0.5;

const NEGATIVE = [
  /false positive/, /not (an? )?(issue|bug|problem|concern)/, /\bintend(ed|ional)\b/, /by design/, /won'?t fix/, /\bwrong\b/,
  /\bincorrect\b/, /doesn'?t apply/, /not relevant/, /\birrelevant\b/, /\bnoise\b/, /\bdisagree\b/, /not needed/, /\bunnecessary\b/,
  /please (stop|don'?t)/, /\bignore (this|these)\b/, /not (true|correct|accurate)/, /\bnope\b/,
];
const POSITIVE = [/good catch/, /nice catch/, /\bthanks?\b/, /thank you/, /\bfixed\b/, /\bdone\b/, /\bagreed?\b/, /\bvalid\b/, /will fix/, /good point/, /\baddressed\b/, /\bgreat\b/];

/** Classifies a reply to a OpenReview comment: -1 rejects it, 1 accepts it, 0 is neutral. */
export function replySentiment(body: string): -1 | 0 | 1 {
  const text = body.toLowerCase();
  if (NEGATIVE.some((r) => r.test(text))) return -1;
  if (POSITIVE.some((r) => r.test(text))) return 1;
  return 0;
}

const isBot = (login: string) => login.endsWith("[bot]") || login === "";

export function signalFor(positive: number, negative: number): "suppress" | "boost" | "neutral" {
  const score = positive - negative;
  if (score <= SUPPRESS_AT) return "suppress";
  if (score >= BOOST_AT) return "boost";
  return "neutral";
}

type CommentRow = { id: number; orgId: string; repoId: number; category: string; title: string; path: string };

/** Attaches one piece of feedback to the matching pattern (creating one if needed) and updates its signal. */
async function applyFeedback(db: Db, comment: CommentRow, sentiment: number): Promise<number | null> {
  if (sentiment === 0) return null;
  const candidates = await db
    .select()
    .from(learnedPatterns)
    .where(scoped(learnedPatterns, comment.orgId, eq(learnedPatterns.repoId, comment.repoId), eq(learnedPatterns.category, comment.category)));
  const match = candidates
    .map((p) => ({ p, sim: Math.max(similarity(p.description, comment.title), ...p.examples.map((e) => similarity(e.title, comment.title))) }))
    .filter((x) => x.sim >= MATCH)
    .sort((a, b) => b.sim - a.sim)[0]?.p;

  const positive = (match?.positive ?? 0) + (sentiment > 0 ? 1 : 0);
  const negative = (match?.negative ?? 0) + (sentiment < 0 ? 1 : 0);
  if (!match) {
    const [row] = await db
      .insert(learnedPatterns)
      .values({
        orgId: comment.orgId,
        repoId: comment.repoId,
        category: comment.category,
        description: comment.title,
        positive,
        negative,
        signal: signalFor(positive, negative),
        examples: [{ title: comment.title, path: comment.path }],
      })
      .returning({ id: learnedPatterns.id });
    return row!.id;
  }
  const examples = match.examples.some((e) => e.title === comment.title)
    ? match.examples
    : [...match.examples, { title: comment.title, path: comment.path }].slice(-10);
  await db
    .update(learnedPatterns)
    .set({ positive, negative, examples, ...(match.userEdited ? {} : { signal: signalFor(positive, negative) }) })
    .where(eq(learnedPatterns.id, match.id));
  return match.id;
}

/**
 * Pulls reactions (👍/👎) and human replies on OpenReview's inline comments for
 * one PR, records each once, and folds new feedback into learned patterns (R2.4).
 * GitHub sends no webhooks for reactions, so this runs on reply webhooks, when a
 * PR closes, and before each re-review.
 */
export async function syncFeedback(deps: { db: Db; host: GitHost }, job: { orgId: string; repoId: number; prNumber: number }) {
  const { db } = deps;
  const [row] = await db
    .select({ repo: repos, installation: installations })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(and(eq(repos.orgId, job.orgId), eq(repos.id, job.repoId)));
  if (!row) throw new Error(`repo ${job.repoId} not found for org ${job.orgId}`);

  const ours = await db
    .select({
      id: reviewComments.id,
      orgId: reviewComments.orgId,
      repoId: reviews.repoId,
      category: reviewComments.category,
      title: reviewComments.title,
      path: reviewComments.path,
      externalId: reviewComments.externalId,
    })
    .from(reviewComments)
    .innerJoin(reviews, eq(reviewComments.reviewId, reviews.id))
    .where(and(eq(reviews.orgId, job.orgId), eq(reviews.repoId, job.repoId), eq(reviews.prNumber, job.prNumber), isNotNull(reviewComments.externalId)));
  if (!ours.length) return { recorded: 0 };
  const byExternal = new Map(ours.map((c) => [c.externalId!, c]));

  const client = deps.host.client(row.installation.externalId);
  const repo = row.repo.fullName;
  const incoming: { comment: CommentRow; kind: "thumbs_up" | "thumbs_down" | "reply"; externalId: number; author: string; body: string | null; sentiment: number }[] = [];

  for (const c of await client.listReviewComments(repo, job.prNumber)) {
    const parent = c.inReplyTo ? byExternal.get(c.inReplyTo) : undefined;
    if (!parent || isBot(c.author)) continue;
    incoming.push({ comment: parent, kind: "reply", externalId: c.id, author: c.author, body: c.body, sentiment: replySentiment(c.body) });
  }
  for (const c of ours) {
    for (const r of await client.listReviewCommentReactions(repo, c.externalId!)) {
      if (isBot(r.user) || (r.content !== "+1" && r.content !== "-1")) continue;
      incoming.push({
        comment: c,
        kind: r.content === "+1" ? "thumbs_up" : "thumbs_down",
        externalId: r.id,
        author: r.user,
        body: null,
        sentiment: r.content === "+1" ? 1 : -1,
      });
    }
  }

  let recorded = 0;
  for (const f of incoming) {
    const [inserted] = await db
      .insert(commentFeedback)
      .values({ orgId: job.orgId, reviewCommentId: f.comment.id, kind: f.kind, externalId: f.externalId, author: f.author, body: f.body, sentiment: f.sentiment })
      .onConflictDoNothing()
      .returning({ id: commentFeedback.id });
    if (!inserted) continue; // already recorded
    recorded++;
    const patternId = await applyFeedback(db, f.comment, f.sentiment);
    if (patternId) await db.update(commentFeedback).set({ patternId }).where(eq(commentFeedback.id, inserted.id));
  }
  return { recorded };
}

export interface LearnedPattern {
  id: number;
  category: string;
  description: string;
  signal: "suppress" | "boost";
  examples: { title: string; path: string }[];
}

/** Active suppress/boost patterns for a repo (its own plus org-wide ones). */
export async function learnedForRepo(db: Db, orgId: string, repoId: number): Promise<LearnedPattern[]> {
  const rows = await db
    .select()
    .from(learnedPatterns)
    .where(
      scoped(
        learnedPatterns,
        orgId,
        inArray(learnedPatterns.signal, ["suppress", "boost"]),
        or(isNull(learnedPatterns.repoId), eq(learnedPatterns.repoId, repoId)),
      ),
    )
    .orderBy(learnedPatterns.id);
  return rows.map((r) => ({ id: r.id, category: r.category, description: r.description, signal: r.signal as "suppress" | "boost", examples: r.examples }));
}

/** The learned pattern a finding falls under, if any. */
export function matchPattern(patterns: LearnedPattern[], f: { category: string; title: string }): LearnedPattern | undefined {
  return patterns.find(
    (p) =>
      p.category === f.category &&
      Math.max(similarity(p.description, f.title), ...p.examples.map((e) => similarity(e.title, f.title))) >= MATCH,
  );
}

export function renderLearnedSection(patterns: LearnedPattern[]): string {
  if (!patterns.length) return "";
  const suppress = patterns.filter((p) => p.signal === "suppress");
  const boost = patterns.filter((p) => p.signal === "boost");
  return [
    "## Team preferences learned from feedback",
    ...(suppress.length ? ["The team has rejected these kinds of comments. Do not report them:", ...suppress.map((p) => `- (${p.category}) ${p.description}`)] : []),
    ...(boost.length ? ["The team values these kinds of comments. Look for them carefully:", ...boost.map((p) => `- (${p.category}) ${p.description}`)] : []),
  ].join("\n");
}

/** User edits from the Learned page. Changing the signal pins it against future feedback. */
export async function updateLearnedPattern(
  db: Db,
  orgId: string,
  id: number,
  patch: { description?: string; signal?: "suppress" | "boost" | "neutral" },
) {
  if (patch.description !== undefined && patch.description.trim().length < 3) throw new Error("Description is too short.");
  const [row] = await db
    .update(learnedPatterns)
    .set({
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.signal !== undefined ? { signal: patch.signal, userEdited: true } : {}),
    })
    .where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, id)))
    .returning();
  return row;
}

export async function deleteLearnedPattern(db: Db, orgId: string, id: number) {
  const rows = await db.delete(learnedPatterns).where(scoped(learnedPatterns, orgId, eq(learnedPatterns.id, id))).returning({ id: learnedPatterns.id });
  return rows.length > 0;
}

export async function listLearnedPatterns(db: Db, orgId: string) {
  return db
    .select({ pattern: learnedPatterns, repoFullName: repos.fullName })
    .from(learnedPatterns)
    .leftJoin(repos, eq(learnedPatterns.repoId, repos.id))
    .where(scoped(learnedPatterns, orgId))
    .orderBy(learnedPatterns.signal, learnedPatterns.id);
}
