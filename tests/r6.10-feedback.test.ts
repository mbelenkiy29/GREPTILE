import { afterEach, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { commentFeedback, findingFeedback as feedbackTable, findings, learnedPatterns, reviews, users } from "@/lib/db/schema";
import {
  FeedbackError,
  feedbackSummary,
  findingFeedback,
  parseFeedbackForm,
  retractFeedback,
  submitFindingFeedback,
  type FeedbackKind,
} from "@/lib/data/feedback";
import { runReview, type Candidate } from "@/lib/engine";
import { runJob, type JobDeps } from "@/lib/jobs/handlers";
import { MemoryQueue, type JobPayloads } from "@/lib/jobs/types";
import {
  createPreference,
  exportPreferences,
  learnedPreferencesForReview,
  listPreferences,
  resetPreferences,
  syncFeedback,
  updatePreference,
} from "@/lib/learning";
import { parseFeedbackCommand } from "@/lib/learning/commands";
import { parseResetForm } from "@/lib/learning/preferences";
import { answerMention } from "@/lib/conversations";
import { runReviewJob } from "@/lib/review/run";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { addReviewReply } from "./helpers/fake-git";
import { candidateAt, engineLlm, engineRequest, PRICING } from "./helpers/engine";
import { tempDir } from "./helpers/fixture-repo";
import { addPrFromFixture } from "./helpers/pr";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

let seq = 0;

async function seedUser(db: Db, id: string) {
  await db.insert(users).values({ id, name: id }).onConflictDoNothing();
  return id;
}

/** A published finding on a fresh PR review of the fixture repo. */
async function seedFinding(f: Fixture, over: Partial<typeof findings.$inferInsert> = {}) {
  const prNumber = 100 + ++seq;
  const [review] = await f.db.insert(reviews).values({ orgId: "org_a", repoId: f.repo.id, prNumber, headSha: f.head }).returning();
  const [row] = await f.db
    .insert(findings)
    .values({
      orgId: "org_a",
      repoId: f.repo.id,
      reviewId: review!.id,
      prNumber,
      title: `Finding ${seq}`,
      severity: "medium",
      confidence: 0.8,
      category: "correctness",
      agent: "correctness",
      agents: ["correctness"],
      path: PRICING,
      startLine: 4,
      endLine: 4,
      commitSha: f.head,
      firstSeenSha: f.head,
      visibility: "published",
      fingerprint: `fp-${seq}`,
      ...over,
    })
    .returning();
  return row!;
}

const dash = (findingId: number, userId: string, kind: FeedbackKind) => ({ orgId: "org_a", findingId, userId, source: "dashboard" as const, kind });

/** The real engine over a fake model; reviewer outputs keyed by agent. */
function scripted(out: Record<string, Candidate[]>) {
  return engineLlm({ review: (agent) => ({ findings: out[agent] ?? [] }) });
}

describe("finding feedback (R6.10)", () => {
  test("R6.10 dashboard feedback changes the finding's status and returns the counts", async () => {
    fx = await reviewFixture();
    const user = await seedUser(fx.db, "u1");
    const a = await seedFinding(fx);
    const b = await seedFinding(fx);
    const c = await seedFinding(fx);

    const resolved = await submitFindingFeedback(fx.db, { ...dash(a.id, user, "resolved"), note: "fixed in a follow-up" });
    expect(resolved).toMatchObject({ duplicate: false, finding: { id: a.id, status: "resolved", resolution: "user" }, counts: { resolved: 1, useful: 0 } });
    expect((await submitFindingFeedback(fx.db, dash(b.id, user, "wont_fix"))).finding).toMatchObject({ status: "wont_fix", resolution: "user" });
    expect((await submitFindingFeedback(fx.db, dash(c.id, user, "false_positive"))).finding).toMatchObject({ status: "false_positive", resolution: "user" });

    // The PR review's aggregates follow, and repeating the same feedback is a no-op.
    const [review] = await fx.db.select().from(reviews).where(eq(reviews.id, a.reviewId));
    expect(review).toMatchObject({ openFindings: 0, resolvedFindings: 1 });
    expect(await submitFindingFeedback(fx.db, dash(a.id, user, "resolved"))).toMatchObject({ duplicate: true, counts: { resolved: 1 } });

    const items = await findingFeedback(fx.db, "org_a", a.id);
    expect(items).toEqual([expect.objectContaining({ kind: "resolved", source: "dashboard", userId: "u1", userName: "u1", note: "fixed in a follow-up" })]);

    // The dashboard form is validated at the boundary.
    const form = new FormData();
    form.set("findingId", String(a.id));
    form.set("kind", "useful");
    expect(parseFeedbackForm(form)).toEqual({ findingId: a.id, kind: "useful" });
    form.set("kind", "approve");
    expect(() => parseFeedbackForm(form)).toThrow(FeedbackError);
  });

  test("R6.10 a user's useful / not-useful vote replaces their previous one, and retracting a status reopens the finding", async () => {
    fx = await reviewFixture();
    const user = await seedUser(fx.db, "u1");
    const other = await seedUser(fx.db, "u2");
    const f = await seedFinding(fx, { title: "Missing null check on items" });

    await submitFindingFeedback(fx.db, dash(f.id, user, "useful"));
    await submitFindingFeedback(fx.db, dash(f.id, other, "useful"));
    const res = await submitFindingFeedback(fx.db, dash(f.id, user, "not_useful"));
    expect(res.counts).toMatchObject({ useful: 1, not_useful: 1 });
    const rows = await fx.db.select().from(feedbackTable).where(eq(feedbackTable.findingId, f.id));
    expect(rows.map((r) => [r.userId, r.kind]).sort()).toEqual([
      ["u1", "not_useful"],
      ["u2", "useful"],
    ]);
    // The replaced vote no longer counts toward the learned pattern.
    const [pattern] = await fx.db.select().from(learnedPatterns).where(eq(learnedPatterns.kind, "pattern"));
    expect(pattern).toMatchObject({ description: "Missing null check on items", positive: 1, negative: 1, evidenceCount: 2, source: "feedback" });

    const wontFix = await submitFindingFeedback(fx.db, dash(f.id, user, "wont_fix"));
    expect(wontFix.finding.status).toBe("wont_fix");
    // Only the author may retract through the user-scoped path.
    expect(await retractFeedback(fx.db, { orgId: "org_a", feedbackId: wontFix.feedbackId, userId: other })).toEqual({ retracted: false });
    expect(await retractFeedback(fx.db, { orgId: "org_a", feedbackId: wontFix.feedbackId, userId: user })).toMatchObject({
      retracted: true,
      finding: { status: "open", resolution: null },
    });
  });

  test("R6.10 GitHub reactions, replies, and commands on a finding's comment map to finding feedback", async () => {
    fx = await reviewFixture();
    const llm = scripted({ correctness: [candidateAt(HEAD_PRICING, 4, { title: "Subtotal ignores discounts", severity: "medium", confidence: 0.8 })] });
    const queue = new MemoryQueue();
    const deps: JobDeps = { db: fx.db, host: fx.host, queue, llm, embedder: fx.embedder, cacheDir: tempDir(), botMention: "openreview" };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    const [comment] = fx.host.reviewComments.get("acme/shop#7")!;
    const [finding] = await fx.db.select().from(findings).where(and(eq(findings.orgId, "org_a"), eq(findings.visibility, "published")));
    expect(finding!.externalCommentId).toBe(comment!.id);

    fx.host.reactions.set(comment!.id, [
      { id: 1, content: "+1", user: "dana" },
      { id: 2, content: "-1", user: "eli" },
      { id: 3, content: "confused", user: "fay" },
      { id: 4, content: "heart", user: "gus" },
    ]);
    addReviewReply(fx.host, "acme/shop", 7, { id: 50, inReplyTo: comment!.id, body: "Good catch, fixed.", author: "dana" });
    // An explicit command is left to the conversation job (it needs an access check).
    addReviewReply(fx.host, "acme/shop", 7, { id: 51, inReplyTo: comment!.id, body: "/openreview won't fix", author: "lee" });
    expect(parseFeedbackCommand("/openreview won't fix", "openreview")).toBe("wont_fix");
    expect(parseFeedbackCommand("@openreview  False positive.", "openreview")).toBe("false_positive");
    expect(parseFeedbackCommand("@openreview this is resolved by the other PR", "openreview")).toBeNull();
    expect(parseFeedbackCommand("won't fix", "openreview")).toBeNull();

    expect(await syncFeedback(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7 })).toEqual({ recorded: 4 });
    const fb = await fx.db.select().from(feedbackTable).where(eq(feedbackTable.findingId, finding!.id));
    expect(fb.map((r) => [r.source, r.kind, r.externalAuthor, r.externalId]).sort()).toEqual([
      ["github_reaction", "not_useful", "eli", 2],
      ["github_reaction", "not_useful", "fay", 3],
      ["github_reaction", "useful", "dana", 1],
      ["github_reply", "useful", "dana", 50],
    ]);
    expect((await fx.db.select().from(commentFeedback)).length).toBe(4);

    // The command arrives by webhook from a collaborator and is applied by the conversation job.
    const handler = createGitHubWebhookHandler(() => ({ db: fx!.db, queue, host: fx!.host, secret: "s", botMention: "openreview" }));
    const body = JSON.stringify({
      action: "created",
      installation: { id: 11 },
      repository: { id: 1 },
      pull_request: { number: 7 },
      comment: { id: 51, in_reply_to_id: comment!.id, body: "/openreview won't fix", path: PRICING, line: 4, user: { login: "lee", type: "User" }, author_association: "COLLABORATOR" },
    });
    const res = await handler(
      new Request("http://x", { method: "POST", body, headers: { "x-github-event": "pull_request_review_comment", "x-github-delivery": "c1", "x-hub-signature-256": signGitHubPayload("s", body) } }),
    );
    expect(res.status).toBe(202);
    const job = queue.jobs.find((j) => j.name === "answer-mention")!;
    expect(job.data).toMatchObject({ authorAssociation: "COLLABORATOR", inReplyTo: comment!.id });
    expect(await runJob(deps, "answer-mention", job.data as JobPayloads["answer-mention"])).toMatchObject({ status: "answered", intent: "feedback" });
    const [after] = await fx.db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(after).toMatchObject({ status: "wont_fix", resolution: "user" });
    expect(fx.host.reviewComments.get("acme/shop#7")!.at(-1)!.body).toContain("is won't fix. Its status is now `wont_fix`.");
    const [cmd] = await fx.db.select().from(feedbackTable).where(eq(feedbackTable.source, "github_command"));
    expect(cmd).toMatchObject({ kind: "wont_fix", externalAuthor: "lee", externalId: 51 });

    // A reaction taken back on GitHub is retracted at the next sync.
    fx.host.reactions.set(comment!.id, [{ id: 1, content: "+1", user: "dana" }]);
    expect(await syncFeedback(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7 })).toEqual({ recorded: 0, retracted: 2 });
    const left = await fx.db.select().from(feedbackTable).where(eq(feedbackTable.source, "github_reaction"));
    expect(left.map((r) => r.externalAuthor)).toEqual(["dana"]);
  });

  test("R6.10 category preferences appear after enough negative feedback, raise the category's threshold in the engine, and can be reset", async () => {
    fx = await reviewFixture();
    const user = await seedUser(fx.db, "u1");
    const seeded = [];
    for (let i = 0; i < 5; i++) seeded.push(await seedFinding(fx, { title: `Distinct correctness concern number ${i} about ${["totals", "taxes", "rows", "items", "regions"][i]}` }));
    // Four findings with feedback: still below the sample size.
    for (const f of seeded.slice(0, 4)) await submitFindingFeedback(fx.db, dash(f.id, user, "not_useful"));
    expect((await listPreferences(fx.db, "org_a")).filter((p) => p.kind === "category")).toEqual([]);
    await submitFindingFeedback(fx.db, dash(seeded[4]!.id, user, "false_positive"));

    const [category] = (await listPreferences(fx.db, "org_a")).filter((p) => p.kind === "category");
    expect(category).toMatchObject({
      kind: "category",
      scope: "repo",
      category: "correctness",
      signal: "suppress",
      confidenceDelta: 0.15,
      positive: 0,
      negative: 5,
      evidenceCount: 5,
      pinned: false,
      description: "correctness findings: 0 of 5 recent findings with feedback were useful (0%)",
    });
    const learned = await learnedPreferencesForReview(fx.db, "org_a", fx.repo.id);
    expect(learned).toContainEqual({ category: "correctness", description: category!.description, signal: "suppress", appliesTo: "category", confidenceDelta: 0.15 });

    // The engine raises correctness's minimum confidence from 0.5 to 0.65; nothing else is blocked.
    const out = {
      correctness: [
        candidateAt(HEAD_PRICING, 4, { title: "Subtotal can be NaN for empty input", confidence: 0.6, severity: "medium" }),
        candidateAt(HEAD_PRICING, 5, { title: "Tax is added before rounding", confidence: 0.7, severity: "medium" }),
      ],
    };
    const llm = scripted(out);
    const review = await runReview({ db: fx.db, llm }, await engineRequest(fx, { learned }));
    expect(review.findings.map((f) => f.title)).toEqual(["Tax is added before rounding"]);
    expect(review.rejected.find((r) => r.title === "Subtotal can be NaN for empty input")).toMatchObject({
      stage: "learned",
      reason: expect.stringContaining("raised for correctness by team feedback"),
    });
    const prompt = llm.calls.find((c) => c.req.task === "review")!.req.prompt;
    expect(prompt).toContain("The team rarely finds comments in these categories useful; report only findings you are highly confident in: correctness");
    const baseline = await runReview({ db: fx.db, llm: scripted(out) }, await engineRequest(fx));
    expect(baseline.findings).toHaveLength(2);

    // Reset forgets it, and the feedback behind it no longer counts toward new preferences.
    const before = (await listPreferences(fx.db, "org_a")).length;
    expect(before).toBeGreaterThan(1);
    expect(await resetPreferences(fx.db, "org_a", { repoId: fx.repo.id })).toEqual({ deleted: before });
    expect(await listPreferences(fx.db, "org_a")).toEqual([]);
    const fresh = await seedFinding(fx, { title: "Yet another unrelated correctness topic entirely" });
    await submitFindingFeedback(fx.db, dash(fresh.id, user, "not_useful"));
    expect((await listPreferences(fx.db, "org_a")).filter((p) => p.kind === "category")).toEqual([]);
    // Summaries still show all feedback.
    expect((await feedbackSummary(fx.db, "org_a")).total).toMatchObject({ notUseful: 5, falsePositive: 1 });
  });

  test("R6.10 a category the team finds useful gets a boost preference", async () => {
    fx = await reviewFixture();
    const user = await seedUser(fx.db, "u1");
    const topics = ["totals", "taxes", "rows", "items", "regions", "currency"];
    for (let i = 0; i < 6; i++) {
      const f = await seedFinding(fx, { category: "security", agent: "security", title: `Separate security topic about ${topics[i]} handling ${i}` });
      await submitFindingFeedback(fx.db, dash(f.id, user, i === 0 ? "not_useful" : "useful"));
    }
    const [category] = (await listPreferences(fx.db, "org_a")).filter((p) => p.kind === "category");
    expect(category).toMatchObject({ category: "security", signal: "boost", confidenceDelta: 0, positive: 5, negative: 1 });
    expect(await learnedPreferencesForReview(fx.db, "org_a", fx.repo.id)).toContainEqual(expect.objectContaining({ category: "security", appliesTo: "category", signal: "boost" }));
  });

  test("R6.10 an explicit ignore-pattern preference suppresses the next matching finding in a review", async () => {
    fx = await reviewFixture();
    const title = "Unused variable subtotal";
    const out: Record<string, Candidate[]> = { correctness: [candidateAt(HEAD_PRICING, 4, { title, severity: "medium", confidence: 0.8 })] };
    const llm = scripted(out);
    const queue = new MemoryQueue();
    const deps: JobDeps = { db: fx.db, host: fx.host, queue, llm, embedder: fx.embedder, cacheDir: tempDir(), botMention: "openreview" };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    const [comment] = fx.host.reviewComments.get("acme/shop#7")!;

    const res = await answerMention(deps, {
      orgId: "org_a",
      repoId: fx.repo.id,
      prNumber: 7,
      commentId: 70,
      body: "@openreview ignore this pattern",
      author: "dana",
      kind: "review_comment",
      inReplyTo: comment!.id,
      authorAssociation: "MEMBER",
    });
    expect(res).toMatchObject({ status: "answered", intent: "ignore_pattern" });
    const [pref] = await listPreferences(fx.db, "org_a");
    expect(pref).toMatchObject({ kind: "pattern", category: "correctness", description: title, signal: "suppress", source: "command", pinned: true });

    // The next PR: the same kind of finding comes back from the model and is dropped.
    const TAX = "services/billing/tax.ts";
    const TAX8 = "export function taxFor(amount: number) {\n  const subtotal = amount;\n  return Math.round(amount * 0.2);\n}\n";
    const head8 = fx.fixture.commit({ [TAX]: TAX8 }, "pr8");
    addPrFromFixture(fx.host, fx.fixture, "acme/shop", { number: 8, base: fx.head, head: head8 });
    out.correctness = [candidateAt(TAX8, 2, { path: TAX, title, severity: "medium", confidence: 0.8 })];
    const before = fx.host.reviews.length;
    expect(await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 8, headSha: head8 })).toMatchObject({ status: "completed", posted: 0 });
    expect(fx.host.reviews.slice(before).flatMap((r) => r.comments)).toEqual([]);
    const [rejected] = await fx.db.select().from(findings).where(and(eq(findings.prNumber, 8), eq(findings.visibility, "rejected")));
    expect(rejected).toMatchObject({ title, verification: expect.objectContaining({ stage: "learned" }) });
  });

  test("R6.10 preferences are listed, edited, created, exported as JSON, and reset keeping pinned ones", async () => {
    fx = await reviewFixture();
    const user = await seedUser(fx.db, "u1");
    const f = await seedFinding(fx, { title: "Prefer early returns" });
    await submitFindingFeedback(fx.db, dash(f.id, user, "not_useful"));
    const g = await seedFinding(fx, { title: "Use structured logging instead of console" });
    await submitFindingFeedback(fx.db, dash(g.id, user, "useful"));
    const created = await createPreference(fx.db, "org_a", { repoId: null, category: "testing", description: "Snapshot tests for generated code", signal: "suppress" });
    expect(created).toMatchObject({ scope: "org", source: "human_rule", userEdited: true });

    const [early] = (await listPreferences(fx.db, "org_a")).filter((p) => p.description === "Prefer early returns");
    const edited = await updatePreference(fx.db, "org_a", early!.id, { description: "Early returns over nested ifs", signal: "suppress" });
    expect(edited).toMatchObject({ description: "Early returns over nested ifs", signal: "suppress", userEdited: true });
    await expect(updatePreference(fx.db, "org_a", early!.id, { description: "x" })).rejects.toThrow("too short");

    const exported = await exportPreferences(fx.db, "org_a", { now: new Date("2026-10-01T00:00:00Z") });
    expect(JSON.parse(JSON.stringify(exported))).toMatchObject({ version: 1, orgId: "org_a", repoId: null, exportedAt: "2026-10-01T00:00:00.000Z" });
    expect(exported.preferences.map((p) => [p.description, p.signal, p.pinned]).sort()).toEqual([
      ["Early returns over nested ifs", "suppress", true],
      ["Snapshot tests for generated code", "suppress", true],
      ["Use structured logging instead of console", "neutral", false],
    ]);

    const form = new FormData();
    expect(parseResetForm(form)).toEqual({ includePinned: false });
    expect(await resetPreferences(fx.db, "org_a", parseResetForm(form))).toEqual({ deleted: 1 });
    expect((await listPreferences(fx.db, "org_a")).map((p) => p.description).sort()).toEqual(["Early returns over nested ifs", "Snapshot tests for generated code"]);
    form.set("includePinned", "on");
    expect(await resetPreferences(fx.db, "org_a", parseResetForm(form))).toEqual({ deleted: 2 });
    expect(await listPreferences(fx.db, "org_a")).toEqual([]);
  });

  test("R6.10 feedback summary reports acceptance rates per category and per agent", async () => {
    fx = await reviewFixture();
    const user = await seedUser(fx.db, "u1");
    const u2 = await seedUser(fx.db, "u2");
    const a = await seedFinding(fx, { category: "security", agent: "security", title: "Token logged in plain text" });
    const b = await seedFinding(fx, { category: "correctness", agent: "correctness", title: "Off by one in pagination" });
    await submitFindingFeedback(fx.db, dash(a.id, user, "useful"));
    await submitFindingFeedback(fx.db, dash(a.id, u2, "useful"));
    await submitFindingFeedback(fx.db, dash(b.id, user, "false_positive"));
    await submitFindingFeedback(fx.db, dash(b.id, u2, "useful"));
    await submitFindingFeedback(fx.db, dash(a.id, user, "resolved"));

    const s = await feedbackSummary(fx.db, "org_a", { repoId: fx.repo.id });
    expect(s.total).toEqual({ useful: 3, notUseful: 0, falsePositive: 1, resolved: 1, wontFix: 0, acceptanceRate: 0.75 });
    expect(s.byCategory).toEqual([
      expect.objectContaining({ category: "correctness", useful: 1, falsePositive: 1, acceptanceRate: 0.5 }),
      expect.objectContaining({ category: "security", useful: 2, resolved: 1, acceptanceRate: 1 }),
    ]);
    expect(s.byAgent.map((x) => [x.agent, x.acceptanceRate])).toEqual([
      ["correctness", 0.5],
      ["security", 1],
    ]);
    expect((await feedbackSummary(fx.db, "org_a", { since: new Date(Date.now() + 60_000) })).total.acceptanceRate).toBeNull();
  });

  test("R6.10 feedback and preferences are isolated per org", async () => {
    fx = await reviewFixture();
    const user = await seedUser(fx.db, "u1");
    const f = await seedFinding(fx, { title: "Missing await on save" });
    const res = await submitFindingFeedback(fx.db, dash(f.id, user, "not_useful"));

    await expect(submitFindingFeedback(fx.db, { ...dash(f.id, user, "resolved"), orgId: "org_b" })).rejects.toThrow(FeedbackError);
    expect(await findingFeedback(fx.db, "org_b", f.id)).toEqual([]);
    expect(await retractFeedback(fx.db, { orgId: "org_b", feedbackId: res.feedbackId })).toEqual({ retracted: false });
    expect((await feedbackSummary(fx.db, "org_b")).total.notUseful).toBe(0);
    expect(await listPreferences(fx.db, "org_b")).toEqual([]);
    expect(await learnedPreferencesForReview(fx.db, "org_b", fx.repo.id)).toEqual([]);
    const [pattern] = await listPreferences(fx.db, "org_a");
    expect(await updatePreference(fx.db, "org_b", pattern!.id, { signal: "boost" })).toBeUndefined();
    expect(await resetPreferences(fx.db, "org_b", { includePinned: true })).toEqual({ deleted: 0 });
    expect(await listPreferences(fx.db, "org_a")).toHaveLength(1);
    await expect(createPreference(fx.db, "org_b", { repoId: fx.repo.id, category: "testing", description: "Anything at all", signal: "suppress" })).rejects.toThrow("Repository not found");
    // Rejected candidates take no feedback.
    const rejected = await seedFinding(fx, { visibility: "rejected" });
    await expect(submitFindingFeedback(fx.db, dash(rejected.id, user, "useful"))).rejects.toThrow("Finding not found");
  });
});
