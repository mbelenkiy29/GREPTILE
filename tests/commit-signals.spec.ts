import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

test("commit outcomes: fixes and merged-open findings become signals, feed a bounded preference and the analytics trend", async () => {
  process.env.SERVICE_SECRET = "signals-service";
  process.env.SESSION_SECRET = "signals-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const userId = await t.mutation(api.users.login, { secret: "signals-service", githubId: 1, login: "signals-1", avatar: "" });
  const token = await new SignJWT({}).setSubject(userId).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Signals" });
  await t.mutation(api.repositories.connect, { token, secret: "signals-service", organizationId, installationId: 81, account: "acme", accountId: 1, repositories: [{ id: 810, fullName: "acme/pay", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  await t.run((ctx) => ctx.db.patch(repo._id, { enabled: true }));
  const sha = (c: string) => c.repeat(40);
  let observed = 1;
  const observe = (number: number, head: string) => t.mutation(internal.pulls.observe, { repositoryId: repo._id, number, title: "Totals", author: "dev", url: `https://github.com/acme/pay/pull/${number}`, headSha: head, baseSha: sha("0"), state: "open", observedAt: observed++ });
  const finding = (fingerprint: string, category: string, head: string, line = 10) => ({ title: `${category} issue ${fingerprint}`, description: "The total divides cents by one hundred before storing.", severity: "medium", confidence: 0.9, category, agent: category, filePath: "pay.ts", startLine: line, endLine: line, commitSha: head, evidence: [{ filePath: "pay.ts", startLine: line, quote: "return cents / 100;" }], impact: "Totals shrink.", suggestedFix: "Keep cents.", symbol: "total", fingerprint });
  // One review at `head`: saved with its findings and resolutions, then completed.
  const review = async (pr: number, head: string, findings: ReturnType<typeof finding>[], resolved: string[] = [], addressed?: string[]) => {
    await observe(pr, head);
    const reviewId = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: pr, headSha: head, status: "summarizing", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
    await t.mutation(internal.reviews.save, { reviewId, storageId, summary: "Recorded.", findings, resolved, ...(addressed ? { addressed } : {}), usage: [] });
    await t.run((ctx) => ctx.db.patch(reviewId, { status: "completed" }));
    return reviewId;
  };
  const signals = () => t.run((ctx) => ctx.db.query("findingSignals").collect());
  const preference = (category: string) => t.run((ctx) => ctx.db.query("learnedPreferences").withIndex("by_source", (q) => q.eq("repositoryId", repo._id).eq("source", "commits:" + category)).first());

  // PR 1: seven performance findings and one security finding; a follow-up commit fixes and touches six.
  const perf = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
  await review(1, sha("1"), [...perf.map((f) => finding(f, "performance", sha("1"))), finding("s1", "security", sha("1"))]);
  await review(1, sha("2"), [], [...perf.slice(0, 6), "s1"], [...perf.slice(0, 5), "s1", "not-resolved"]);
  expect((await signals()).map((s) => [s.signal, s.category, s.commitSha]).sort()).toEqual([...perf.slice(0, 5).map(() => ["addressed", "performance", sha("2")]), ["addressed", "security", sha("2")]].sort());
  // Five performance fixes reach the learner's minimum; one security fix does not.
  expect((await preference("performance"))?.instruction).toMatch(/^Authors fixed 5 of the last 5 performance findings/);
  expect(await preference("security")).toBeNull();
  // An admin disables the learned preference; later signals update the counts but keep it disabled.
  const learned = (await preference("performance"))!;
  await t.mutation(api.settings.setPreferenceEnabled, { token, preferenceId: learned._id, enabled: false });
  await review(1, sha("3"), [], ["a6", "a7"], ["a6", "a7"]);
  expect([(await preference("performance"))?.instruction.slice(0, 41), (await preference("performance"))?.enabled]).toEqual(["Authors fixed 7 of the last 7 performance", false]);
  // Re-saving the same outcome records nothing new (one signal per finding).
  await review(1, sha("4"), [], ["a1"], ["a1"]);
  expect((await signals()).length).toBe(8);

  // PR 2: performance, security and data findings merged open. Human feedback excludes d1.
  const pr2 = [...["p1", "p2", "p3", "p4", "p5"].map((f) => finding(f, "performance", sha("5"))), ...["s2", "s3", "s4", "s5", "s6"].map((f) => finding(f, "security", sha("5"))), ...["d1", "d2", "d3", "d4", "d5", "d6"].map((f) => finding(f, "data", sha("5")))];
  await review(2, sha("5"), pr2);
  const d1 = (await t.run((ctx) => ctx.db.query("findings").withIndex("by_fingerprint", (q) => q.eq("repositoryId", repo._id).eq("prNumber", 2).eq("fingerprint", "d1")).first()))!;
  await t.mutation(api.dashboard.feedback, { token, findingId: d1._id, value: "not_useful", comment: "Not a real problem." });
  // GitHub merges arrive as closed + merged=true and schedule the sweep; plain closes do not.
  const scheduled = async () => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((s) => s.name.includes("recordMerge")).length;
  await t.mutation(internal.webhooks.lifecycle, { repositoryId: repo._id, action: "closed", prNumber: 3, state: "closed" });
  expect(await scheduled()).toBe(0);
  await t.mutation(internal.webhooks.lifecycle, { repositoryId: repo._id, action: "closed", prNumber: 2, state: "closed", merged: true });
  await t.mutation(internal.webhooks.lifecycle, { repositoryId: repo._id, action: "closed", prNumber: 2, state: "merged" });
  expect(await scheduled()).toBe(2);
  // A commit merged after the last review: nothing is recorded (it may have fixed the findings).
  await observe(2, sha("6"));
  expect(await t.mutation(internal.commitSignals.recordMerge, { repositoryId: repo._id, prNumber: 2 })).toEqual({ ignored: 0, reason: "commits after the last review were merged unreviewed" });
  await observe(2, sha("5"));
  expect((await t.mutation(internal.commitSignals.recordMerge, { repositoryId: repo._id, prNumber: 2 })).ignored).toBe(15);
  await t.mutation(internal.commitSignals.recordMerge, { repositoryId: repo._id, prNumber: 2 });
  const all = await signals();
  expect([all.filter((s) => s.signal === "ignored").length, all.some((s) => s.findingId === d1._id)]).toEqual([15, false]);
  // Learner: performance is now mixed (7 fixed, 5 ignored) so its preference is withdrawn; data is mostly
  // ignored and asks for stronger evidence; security is never narrowed.
  expect(await preference("performance")).toBeNull();
  expect((await preference("data"))?.instruction).toMatch(/^Authors merged 5 of the last 5 data findings .* only when the evidence shows a concrete defect and its impact\.$/);
  expect(await preference("security")).toBeNull();
  const reviewPreferences = (await t.query(internal.repositories.data, { repositoryId: repo._id as Id<"repositories"> })).preferences.map((p) => p.source);
  expect(reviewPreferences).toContain("commits:data");

  // Analytics: today's rollup counts both outcomes and the trend reports the fixed-before-merge rate.
  const day = new Date().toISOString().slice(0, 10);
  await t.mutation(internal.analyticsRollup.rollupDay, { organizationId, day });
  const trend = await t.query(api.analytics.trends, { token, organizationId, since: Date.now() - 86400000, until: Date.now() });
  expect([trend.totals.commitAddressed, trend.totals.ignored, trend.fixRate]).toEqual([8, 15, 8 / 23]);
  expect(trend.days.find((d) => d.day === day)).toMatchObject({ commitAddressed: 8, ignored: 15 });
  expect(trend.byAuthor.find((a) => a.label === "@dev")).toMatchObject({ commitAddressed: 8, ignored: 15 });
});
