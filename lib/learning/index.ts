/**
 * Learning from feedback (R2.4, R6.10). GitHub reactions and replies on OpenReview's inline comments are collected
 * by {@link syncFeedback}: each is kept once in `comment_feedback` (the raw GitHub ledger) and, when the comment
 * published a finding, recorded as finding feedback (`lib/data/feedback.ts`), which updates the finding and the
 * learned preferences (`./preferences.ts`). Comments posted before findings existed teach the patterns directly.
 */
import { clientFor } from "@/lib/git/hosts";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { commentFeedback, installations, learnedPatterns, repos, reviewComments, reviews } from "@/lib/db/schema";
import { githubReactionFeedback, retractFeedback, submitFindingFeedback, type FeedbackKind } from "@/lib/data/feedback";
import { scoped } from "@/lib/data/tenant";
import type { GitHost } from "@/lib/git/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { similarity } from "@/lib/review/text";
import { parseFeedbackCommand } from "./commands";
import { PATTERN_MATCH, recordPatternSignal, updatePreference, deletePreference, type PreferenceSignal } from "./preferences";

export {
  BOOST_AT,
  SUPPRESS_AT,
  signalFor,
  createPreference,
  deletePreference,
  exportPreferences,
  ignorePatternPreference,
  learnedPreferencesForReview,
  listPreferences,
  recomputeCategoryPreference,
  resetPreferences,
  updatePreference,
  PreferenceError,
  type Preference,
  type PreferencesExport,
} from "./preferences";

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

/** Reactions that count as feedback: 👍 is useful; 👎 and 😕 are not useful. */
const REACTION_KIND: Record<string, { ledger: "thumbs_up" | "thumbs_down"; kind: FeedbackKind; sentiment: 1 | -1 }> = {
  "+1": { ledger: "thumbs_up", kind: "useful", sentiment: 1 },
  "-1": { ledger: "thumbs_down", kind: "not_useful", sentiment: -1 },
  confused: { ledger: "thumbs_down", kind: "not_useful", sentiment: -1 },
};

type CommentRow = { id: number; orgId: string; repoId: number; category: string; title: string; path: string; findingId: number | null };

interface Incoming {
  comment: CommentRow;
  ledger: "thumbs_up" | "thumbs_down" | "reply";
  externalId: number;
  author: string;
  body: string | null;
  sentiment: -1 | 0 | 1;
  kind: FeedbackKind | null;
  source: "github_reaction" | "github_reply";
}

export interface SyncFeedbackDeps {
  db: Db;
  host: GitHost;
  /** Bot name; replies that are explicit commands to it are left to the conversation handler (R6.17). */
  botMention?: string;
  log?: Logger;
}

/**
 * Pulls reactions (👍/👎/😕) and human replies on OpenReview's inline comments for one PR, records each once, and
 * applies it (R2.4, R6.10). A reaction that was removed on GitHub is retracted. GitHub sends no webhooks for
 * reactions, so this runs on reply webhooks, when a PR closes, and before each re-review.
 */
export async function syncFeedback(deps: SyncFeedbackDeps, job: { orgId: string; repoId: number; prNumber: number }) {
  const { db } = deps;
  const log = (deps.log ?? rootLog).child({ orgId: job.orgId, repoId: job.repoId, prNumber: job.prNumber });
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
      findingId: reviewComments.findingId,
    })
    .from(reviewComments)
    .innerJoin(reviews, eq(reviewComments.reviewId, reviews.id))
    .where(and(eq(reviews.orgId, job.orgId), eq(reviewComments.orgId, job.orgId), eq(reviews.repoId, job.repoId), eq(reviews.prNumber, job.prNumber), isNotNull(reviewComments.externalId)));
  if (!ours.length) return { recorded: 0 };
  const byExternal = new Map(ours.map((c) => [c.externalId!, c]));

  const client = clientFor(deps.host, row.installation);
  const repo = row.repo.fullName;
  const incoming: Incoming[] = [];

  for (const c of await client.listReviewComments(repo, job.prNumber)) {
    const parent = c.inReplyTo ? byExternal.get(c.inReplyTo) : undefined;
    if (!parent || isBot(c.author)) continue;
    // "/openreview resolved" and the like are commands, handled (with an access check) by the conversation job.
    if (deps.botMention && parseFeedbackCommand(c.body, deps.botMention)) continue;
    const sentiment = replySentiment(c.body);
    incoming.push({
      comment: parent,
      ledger: "reply",
      externalId: c.id,
      author: c.author,
      body: c.body,
      sentiment,
      kind: sentiment > 0 ? "useful" : sentiment < 0 ? "not_useful" : null,
      source: "github_reply",
    });
  }
  // Reaction ids currently on each finding's comments (to retract feedback for removed reactions).
  const liveReactions = new Map<number, Set<number>>();
  for (const c of ours) {
    const reactions = await client.listReviewCommentReactions(repo, job.prNumber, c.externalId!);
    if (c.findingId !== null) {
      const live = liveReactions.get(c.findingId) ?? new Set<number>();
      for (const r of reactions) live.add(r.id);
      liveReactions.set(c.findingId, live);
    }
    for (const r of reactions) {
      const mapped = REACTION_KIND[r.content];
      if (isBot(r.user) || !mapped) continue;
      incoming.push({
        comment: c,
        ledger: mapped.ledger,
        externalId: r.id,
        author: r.user,
        body: null,
        sentiment: mapped.sentiment,
        kind: mapped.kind,
        source: "github_reaction",
      });
    }
  }

  let recorded = 0;
  for (const f of incoming) {
    const [inserted] = await db
      .insert(commentFeedback)
      .values({ orgId: job.orgId, reviewCommentId: f.comment.id, kind: f.ledger, externalId: f.externalId, author: f.author, body: f.body, sentiment: f.sentiment })
      .onConflictDoNothing()
      .returning({ id: commentFeedback.id });
    if (!inserted) continue; // already recorded
    recorded++;
    let patternId: number | null = null;
    if (f.comment.findingId !== null) {
      if (!f.kind) continue;
      try {
        const res = await submitFindingFeedback(db, {
          orgId: job.orgId,
          findingId: f.comment.findingId,
          externalAuthor: f.author,
          externalId: f.externalId,
          source: f.source,
          kind: f.kind,
          note: f.body,
        });
        patternId = res.patternId;
      } catch (err) {
        log.warn("could not record finding feedback", { findingId: f.comment.findingId, error: errorMessage(err) });
        continue;
      }
    } else if (f.sentiment !== 0) {
      // A comment from before findings existed: teach the pattern directly.
      patternId = await recordPatternSignal(db, {
        orgId: job.orgId,
        repoId: f.comment.repoId,
        category: f.comment.category,
        title: f.comment.title,
        path: f.comment.path,
        sentiment: f.sentiment,
        source: f.source === "github_reply" ? "reply" : "feedback",
      });
    }
    if (patternId) await db.update(commentFeedback).set({ patternId }).where(scoped(commentFeedback, job.orgId, eq(commentFeedback.id, inserted.id)));
  }

  // Reactions people took back on GitHub no longer count.
  let retracted = 0;
  for (const fb of await githubReactionFeedback(db, job.orgId, [...liveReactions.keys()])) {
    if (fb.externalId === null || liveReactions.get(fb.findingId)?.has(fb.externalId)) continue;
    if ((await retractFeedback(db, { orgId: job.orgId, feedbackId: fb.id })).retracted) retracted++;
  }
  return retracted ? { recorded, retracted } : { recorded };
}

export interface LearnedPattern {
  id: number;
  category: string;
  description: string;
  signal: "suppress" | "boost";
  examples: { title: string; path: string }[];
}

/** Active suppress/boost title patterns for a repo (its own plus org-wide ones); category preferences excluded. */
export async function learnedForRepo(db: Db, orgId: string, repoId: number): Promise<LearnedPattern[]> {
  const rows = await db
    .select()
    .from(learnedPatterns)
    .where(
      scoped(
        learnedPatterns,
        orgId,
        eq(learnedPatterns.kind, "pattern"),
        or(eq(learnedPatterns.signal, "suppress"), eq(learnedPatterns.signal, "boost")),
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
      Math.max(similarity(p.description, f.title), ...p.examples.map((e) => similarity(e.title, f.title))) >= PATTERN_MATCH,
  );
}

/** User edits from the Learned page. Any edit pins the preference against future feedback. */
export async function updateLearnedPattern(db: Db, orgId: string, id: number, patch: { description?: string; signal?: PreferenceSignal }) {
  return updatePreference(db, orgId, id, patch);
}

export async function deleteLearnedPattern(db: Db, orgId: string, id: number) {
  return deletePreference(db, orgId, id);
}

export async function listLearnedPatterns(db: Db, orgId: string) {
  return db
    .select({ pattern: learnedPatterns, repoFullName: repos.fullName })
    .from(learnedPatterns)
    .leftJoin(repos, and(eq(learnedPatterns.repoId, repos.id), eq(repos.orgId, orgId)))
    .where(scoped(learnedPatterns, orgId))
    .orderBy(learnedPatterns.signal, learnedPatterns.kind, learnedPatterns.id);
}
