import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FindingFeedback } from "@/components/dashboard/FindingFeedback";
import { LearnedList } from "@/components/dashboard/LearnedList";
import { feedbackForFindings, retractFeedback, submitFindingFeedback } from "@/lib/data/feedback";
import { searchFindings } from "@/lib/data/findings";
import type { Db } from "@/lib/db";
import { findings, installations, learnedPatterns, repos, reviews } from "@/lib/db/schema";
import { createPreferencesExportHandler } from "@/lib/learning/export-handler";
import { createPreference, deletePreference, listPreferences, resetPreferences, updatePreference } from "@/lib/learning/preferences";
import { makeUser, NOW, signedInCookie, TEST_SECRET, testAuthConfig, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";

// The feedback controls refresh the page through the App Router after a change; render them without one.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

let db: Db;
let ext = 90_000;
let seq = 0;

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
});

/** An org with one repository and a PR review to attach findings to. */
async function orgWithReview(login: string) {
  const owner = await userWithOrg(db, { login });
  const [inst] = await db.insert(installations).values({ orgId: owner.org.id, externalId: ++ext, accountLogin: login }).returning();
  const [repo] = await db.insert(repos).values({ orgId: owner.org.id, installationId: inst!.id, externalId: ++ext, fullName: `${login}/app` }).returning();
  const [review] = await db.insert(reviews).values({ orgId: owner.org.id, repoId: repo!.id, prNumber: 1, headSha: "abc", prAuthor: "dev", prTitle: "Change" }).returning();
  const finding = async (over: Partial<typeof findings.$inferInsert> = {}) => {
    const [row] = await db
      .insert(findings)
      .values({
        orgId: owner.org.id,
        repoId: repo!.id,
        reviewId: review!.id,
        prNumber: 1,
        title: `Finding ${++seq}`,
        severity: "medium",
        confidence: 0.8,
        category: "correctness",
        agent: "correctness",
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        commitSha: "abc",
        firstSeenSha: "abc",
        visibility: "published",
        fingerprint: `fp-${seq}`,
        ...over,
      })
      .returning();
    return row!;
  };
  return { ...owner, repo: repo!, finding };
}

const vote = (orgId: string, findingId: number, userId: string, kind: "useful" | "not_useful" | "resolved" | "wont_fix" | "false_positive", note?: string) =>
  submitFindingFeedback(db, { orgId, findingId, userId, source: "dashboard", kind, ...(note ? { note } : {}), now: NOW });

describe("finding feedback UI", () => {
  test("R6.10 feedback buttons' actions update votes and status, and the view shows the current user's vote", async () => {
    const a = await orgWithReview("ann");
    const b = await orgWithReview("ben");
    const teammate = await makeUser(db, "tim");
    const f1 = await a.finding();
    const f2 = await a.finding();
    const foreign = await b.finding();

    await vote(a.org.id, f1.id, a.user.id, "useful");
    await vote(a.org.id, f1.id, teammate.id, "not_useful");
    // Switching a vote replaces it.
    await vote(a.org.id, f2.id, a.user.id, "useful");
    const switched = await vote(a.org.id, f2.id, a.user.id, "not_useful");
    expect(switched.counts).toMatchObject({ useful: 0, not_useful: 1 });
    // Status feedback with a note changes the finding's status.
    const fp = await vote(a.org.id, f1.id, a.user.id, "false_positive", "It's guarded upstream.");
    expect(fp.finding.status).toBe("false_positive");

    const views = await feedbackForFindings(db, a.org.id, a.user.id, [f1.id, f2.id, foreign.id]);
    expect([...views.keys()].sort()).toEqual([f1.id, f2.id].sort());
    expect(views.get(f1.id)).toMatchObject({ useful: 1, notUseful: 1, myVote: { kind: "useful" } });
    expect(views.get(f1.id)!.myStatus).toEqual([{ kind: "false_positive", feedbackId: fp.feedbackId, note: "It's guarded upstream." }]);
    expect(views.get(f2.id)).toMatchObject({ useful: 0, notUseful: 1, myVote: { kind: "not_useful", feedbackId: switched.feedbackId }, myStatus: [] });
    // Another org's session sees nothing of this org's findings.
    expect((await feedbackForFindings(db, b.org.id, b.user.id, [f1.id])).size).toBe(0);

    // Undoing the status feedback reopens the finding; taking back the vote clears it.
    const undone = await retractFeedback(db, { orgId: a.org.id, feedbackId: fp.feedbackId, userId: a.user.id });
    expect(undone.finding?.status).toBe("open");
    await retractFeedback(db, { orgId: a.org.id, feedbackId: views.get(f1.id)!.myVote!.feedbackId, userId: a.user.id });
    expect((await feedbackForFindings(db, a.org.id, a.user.id, [f1.id])).get(f1.id)).toMatchObject({ useful: 0, notUseful: 1, myVote: null, myStatus: [] });

    const view = (await feedbackForFindings(db, a.org.id, a.user.id, [f2.id])).get(f2.id)!;
    const actions = { give: async () => ({ ok: false as const, error: "unused" }), retract: async () => ({ ok: true as const, retracted: true }) };
    const html = renderToStaticMarkup(<FindingFeedback findingId={f2.id} status="open" view={view} canGive actions={actions} />);
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*Useful <span class="tab-count">0<\/span>/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Not useful <span class="tab-count">1<\/span>/);
    for (const label of ["Resolved", "Won&#x27;t fix", "False positive", "Note"]) expect(html).toContain(label);
    expect(html).toContain('data-status="open"');
    const readOnly = renderToStaticMarkup(<FindingFeedback findingId={f2.id} status="resolved" view={view} canGive={false} actions={actions} />);
    expect(readOnly).toContain("0 useful · 1 not useful");
    expect(readOnly).not.toContain("aria-pressed");
  });

  test("R6.10 the findings usefulness filter matches useful, not useful, no feedback, and false positive", async () => {
    const a = await orgWithReview("cam");
    const b = await orgWithReview("dot");
    const useful = await a.finding({ title: "Useful one" });
    const notUseful = await a.finding({ title: "Not useful one" });
    await a.finding({ title: "Untouched" });
    await a.finding({ title: "Closed as false positive", status: "false_positive" });
    const fpVote = await a.finding({ title: "Voted false positive" });
    const ruled = await a.finding({ title: "Cites a rule", ruleId: "rule:7" });
    const other = await b.finding({ title: "Other org useful" });
    await vote(a.org.id, useful.id, a.user.id, "useful");
    await vote(a.org.id, notUseful.id, a.user.id, "not_useful");
    await vote(a.org.id, fpVote.id, a.user.id, "false_positive");
    await vote(a.org.id, ruled.id, a.user.id, "resolved");
    await vote(b.org.id, other.id, b.user.id, "useful");

    const titles = async (f: Parameters<typeof searchFindings>[2]) => (await searchFindings(db, a.org.id, f)).items.map((x) => x.title).sort();
    expect(await titles({ usefulness: "useful" })).toEqual(["Useful one"]);
    expect(await titles({ usefulness: "not_useful" })).toEqual(["Not useful one"]);
    expect(await titles({ usefulness: "false_positive" })).toEqual(["Closed as false positive", "Voted false positive"]);
    expect(await titles({ usefulness: "none" })).toEqual(["Closed as false positive", "Untouched"]);
    expect(await titles({ rule: "rule:7" })).toEqual(["Cites a rule"]);
    expect((await searchFindings(db, a.org.id, { usefulness: "useful" })).total).toBe(1);
  });

  test("R6.10 learned preferences can be edited, deleted, reset, and exported", async () => {
    const a = await orgWithReview("eve");
    const b = await orgWithReview("fay");
    const learned = async (orgId: string, description: string, over: Partial<typeof learnedPatterns.$inferInsert> = {}) => {
      const [row] = await db
        .insert(learnedPatterns)
        .values({ orgId, repoId: null, scope: "org", category: "style", description, signal: "suppress", negative: 3, evidenceCount: 3, lastSignalAt: NOW, ...over })
        .returning();
      return row!;
    };
    const naming = await learned(a.org.id, "Naming nitpicks");
    const nulls = await learned(a.org.id, "Missing null checks", { signal: "boost", category: "correctness", positive: 4, negative: 0, evidenceCount: 4 });
    const pinned = await createPreference(db, a.org.id, { repoId: a.repo.id, category: "security", description: "Always flag SQL built from strings", signal: "boost" });
    const foreign = await learned(b.org.id, "Other org preference");

    // Edit: description and signal; the edit pins it. Another org can't touch it.
    expect(await updatePreference(db, b.org.id, naming.id, { signal: "boost" })).toBeUndefined();
    const edited = await updatePreference(db, a.org.id, naming.id, { description: "Variable naming nitpicks", signal: "neutral" });
    expect(edited).toMatchObject({ description: "Variable naming nitpicks", signal: "neutral", userEdited: true });
    // Delete.
    expect(await deletePreference(db, b.org.id, nulls.id)).toBe(false);
    expect(await deletePreference(db, a.org.id, nulls.id)).toBe(true);

    // The list shows scope, category, description, signal, evidence, last signal, and pinned.
    const prefs = await listPreferences(db, a.org.id);
    const html = renderToStaticMarkup(<LearnedList items={prefs.map((p) => ({ ...p, userEdited: p.pinned }))} />);
    expect(html).toContain("Variable naming nitpicks");
    expect(html).toContain("3 signals · last 2026-03-01");
    expect(html).toContain("eve/app");
    expect(html).toContain("All repositories");
    expect(html).toContain("Pinned");

    // Export: signed-in members of the org only, as a JSON download of this org's preferences.
    const handler = createPreferencesExportHandler(() => ({ db, clock: { now: NOW, ttlDays: testAuthConfig.sessionTtlDays } }));
    const url = `${testAuthConfig.appUrl}/api/orgs/current/preferences/export`;
    expect((await handler(new Request(url))).status).toBe(401);
    const noOrg = await signedInCookie(db, a.user.id, null);
    expect((await handler(new Request(url, { headers: { cookie: noOrg.cookie } }))).status).toBe(403);
    expect((await handler(new Request(`${url}?repoId=abc`, { headers: { cookie: a.cookie } }))).status).toBe(400);
    const res = await handler(new Request(url, { headers: { cookie: a.cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="openreview-preferences-${a.org.slug}-2026-03-01.json"`);
    const doc = (await res.json()) as { version: number; orgId: string; preferences: { description: string }[] };
    expect(doc).toMatchObject({ version: 1, orgId: a.org.id });
    expect(doc.preferences.map((p) => p.description).sort()).toEqual(["Always flag SQL built from strings", "Variable naming nitpicks"]);
    expect(JSON.stringify(doc)).not.toContain(foreign.description);

    // Reset: keeps pinned ones unless asked; other orgs are untouched.
    await learned(a.org.id, "Unpinned learned thing");
    expect(await resetPreferences(db, a.org.id)).toEqual({ deleted: 1 });
    expect((await listPreferences(db, a.org.id)).map((p) => p.id).sort()).toEqual([naming.id, pinned.id].sort());
    expect(await resetPreferences(db, a.org.id, { includePinned: true })).toEqual({ deleted: 2 });
    expect(await listPreferences(db, a.org.id)).toEqual([]);
    expect((await listPreferences(db, b.org.id)).map((p) => p.id)).toEqual([foreign.id]);
  });
});
