import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import { purgePlan, sharedTables } from "../convex/dataControls";

const modules = import.meta.glob("../convex/**/*.ts");
beforeEach(() => { process.env.SERVICE_SECRET = "data-service"; process.env.SESSION_SECRET = "data-session-secret-at-least-32-characters"; vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 12)); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.WORKSPACE_DELETION_GRACE_DAYS; });
type Tables = Record<string, { indexes: { indexDescriptor: string; fields: string[] }[] }>;
const tables = (schema as unknown as { tables: Tables }).tables;

test("every table is either purged with a workspace or explicitly shared, through an index that exists", () => {
  const planned = new Set(purgePlan.map((s) => s.table)), shared = new Set(Object.keys(sharedTables));
  const unaccounted = Object.keys(tables).filter((t) => !planned.has(t as TableNames) && !shared.has(t));
  expect(unaccounted).toEqual([]);
  expect([...planned].filter((t) => shared.has(t))).toEqual([]);
  expect(purgePlan.at(-1)).toEqual({ table: "organizations", via: "self" });
  expect(purgePlan.at(-2)?.table).toBe("auditEvents");
  const indexFirst = (table: string, index: string) => tables[table].indexes.find((i) => i.indexDescriptor === index)?.fields[0];
  for (const step of purgePlan) {
    if (step.via === "org") expect(indexFirst(step.table, step.index), step.table).toBe("organizationId");
    if (step.via === "repo") expect(indexFirst(step.table, step.index), step.table).toBe("repositoryId");
    if (step.via === "child" || step.via === "repoChild") { expect(indexFirst(step.table, step.index), step.table).toBe(step.field); expect(indexFirst(step.parent.table, step.parent.index), step.parent.table).toBe(step.via === "child" ? "organizationId" : "repositoryId"); }
  }
  // Children are purged before their parents are.
  const position = (t: string) => purgePlan.findIndex((s) => s.table === t);
  for (const step of purgePlan) if (step.via === "child" || step.via === "repoChild") expect(position(step.table)).toBeLessThan(position(step.parent.table));
  expect(position("indexJobs")).toBeLessThan(position("repositories"));
});

async function workspace(t: ReturnType<typeof convexTest>, githubId: number, name: string) {
  const userId = await t.mutation(api.users.login, { secret: "data-service", githubId, login: "u" + githubId, avatar: "" });
  const token = await new SignJWT({}).setSubject(userId).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setIssuedAt().setExpirationTime("30d").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name });
  await t.mutation(api.repositories.connect, { token, secret: "data-service", organizationId, installationId: githubId, account: name.toLowerCase(), accountId: githubId, repositories: [{ id: githubId * 10, fullName: `${name.toLowerCase()}/app`, defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  // Representative rows for every access path: org index, per repository, repository children,
  // children of workspace rows, scanned tables, stored files and a large table that needs several chunks.
  const seeded = await t.run(async (ctx) => {
    const file = (text: string) => ctx.storage.store(new Blob([text]));
    const storage = [await file("source"), await file("review result"), await file("agent state")];
    const now = Date.now();
    await ctx.db.insert("repositoryFiles", { organizationId, repositoryId: repo._id, path: "a.ts", sha: "s", storageId: storage[0], language: "typescript", updatedAt: now });
    for (let i = 0; i < 230; i++) await ctx.db.insert("codeChunks", { organizationId, repositoryId: repo._id, filePath: `f${i}.ts`, startLine: 1, content: "x" });
    const jobId = await ctx.db.insert("indexJobs", { organizationId, repositoryId: repo._id, sha: "a".repeat(40), status: "done", attempts: 1, processed: 1, total: 1, changed: 1, createdAt: now, updatedAt: now });
    await ctx.db.insert("indexSkippedFiles", { jobId, path: "big.bin" });
    const reviewId = await ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 1, headSha: "b".repeat(40), status: "completed", mode: "standard", attempts: 1, resultStorageId: storage[1], agentStateStorageId: storage[2], createdAt: now, updatedAt: now });
    const snapshot = { title: "t", description: "d", severity: "high", confidence: 0.9, category: "correctness", filePath: "a.ts", startLine: 1, endLine: 1, evidence: [], impact: "i", suggestedFix: "s", agent: "correctness", symbol: "x", fingerprint: "fp", commitSha: "b".repeat(40) };
    const findingId = await ctx.db.insert("findings", { organizationId, repositoryId: repo._id, reviewId, prNumber: 1, ...snapshot, status: "open", createdAt: now, updatedAt: now });
    await ctx.db.insert("reviewFindings", { reviewId, findingId, snapshot });
    const threadId = await ctx.db.insert("chatThreads", { organizationId, userId, repositoryIds: [repo._id], title: "q", createdAt: now, updatedAt: now });
    await ctx.db.insert("chatMessages", { organizationId, threadId, userId, role: "user", content: "hello", repositoryIds: [repo._id], status: "done", createdAt: now, updatedAt: now });
    const teamId = await ctx.db.insert("teams", { organizationId, name: "T", createdAt: now });
    await ctx.db.insert("teamMembers", { organizationId, teamId, userId, role: "member" });
    const grantId = await ctx.db.insert("oauthGrants", { organizationId, userId, clientId: "c", clientName: "c", scopes: ["read"], resource: "r", revoked: false, createdAt: now });
    await ctx.db.insert("oauthTokens", { hash: "h" + githubId, grantId, kind: "access", expiresAt: now + 1000 });
    await ctx.db.insert("oauthCodes", { hash: "c" + githubId, clientId: "c", clientName: "c", redirectUri: "r", codeChallenge: "x", resource: "r", scopes: ["read"], organizationId, userId, expiresAt: now, used: false });
    await ctx.db.insert("notificationDeliveries", { organizationId, key: "k" + githubId, channel: "email", status: "sent", createdAt: now, updatedAt: now });
    await ctx.db.insert("apiKeys", { organizationId, userId, hash: "k" + githubId, name: "k", prefix: "or_", createdAt: now, revoked: false });
    await ctx.db.insert("customRules", { organizationId, title: "r", instructions: "i", category: "rules", severity: "low", globs: [], enabled: true, createdAt: now });
    await ctx.db.insert("usageEvents", { organizationId, repositoryId: repo._id, kind: "review", inputTokens: 1, outputTokens: 1, estimatedCost: 0, durationMs: 1, createdAt: now });
    return { storage, reviewId, threadId };
  });
  return { userId, token, organizationId, repo, ...seeded };
}
// Rows that belong to a workspace, found the slow way (full scans), to check the purge independently.
// Deletion receipts are kept on purpose.
async function owned(t: ReturnType<typeof convexTest>, organizationId: Id<"organizations">, repositoryId: Id<"repositories">) {
  return t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const name of Object.keys(tables).filter((n) => n !== "workspaceDeletions")) {
      const rows = await ctx.db.query(name as TableNames).collect() as Record<string, unknown>[];
      const mine = rows.filter((r) => r.organizationId === organizationId || r.repositoryId === repositoryId || r._id === organizationId);
      if (mine.length) counts[name] = mine.length;
    }
    return counts;
  });
}

test("workspace deletion: owner-only with a grace period, cancellable, then a resumable purge that leaves other workspaces intact", async () => {
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 501, "Acme"), rival = await workspace(t, 502, "Rival");
  const adminId = await t.mutation(api.users.login, { secret: "data-service", githubId: 503, login: "admin503", avatar: "" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: acme.organizationId, userId: adminId, role: "admin" }));
  const admin = await new SignJWT({}).setSubject(adminId).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("30d").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const rivalBefore = await owned(t, rival.organizationId, rival.repo._id);
  // Only the owner, and only with the exact name.
  await expect(t.mutation(api.dataControls.requestDeletion, { token: admin, organizationId: acme.organizationId, confirmName: "Acme" })).rejects.toThrow(/Only the workspace owner/);
  await expect(t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "acme" })).rejects.toThrow(/exactly/);
  // Cancelled during the grace period: nothing is deleted.
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  expect((await t.query(api.dataControls.settings, { token: acme.token, organizationId: acme.organizationId })).deletion?.status).toBe("scheduled");
  await expect(t.mutation(api.dataControls.cancelDeletion, { token: admin, organizationId: acme.organizationId })).rejects.toThrow(/owner/);
  await t.mutation(api.dataControls.cancelDeletion, { token: acme.token, organizationId: acme.organizationId });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect(await t.run((ctx) => ctx.db.get(acme.organizationId))).not.toBeNull();
  // Requested again; after 7 days the purge starts and runs in chunks until done.
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  vi.setSystemTime(Date.UTC(2026, 9, 21, 12, 1));
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const receipt = (await t.run((ctx) => ctx.db.query("workspaceDeletions").collect())).find((d) => d.status === "done")!;
  expect(receipt.counts).toMatchObject({ codeChunks: 230, reviews: 1, findings: 1, reviewFindings: 1, chatMessages: 1, oauthTokens: 1, indexSkippedFiles: 1, organizations: 1 });
  expect(await owned(t, acme.organizationId, acme.repo._id)).toEqual({});
  expect(await t.run(async (ctx) => Promise.all(acme.storage.map((id) => ctx.storage.get(id))))).toEqual([null, null, null]);
  // Rows reached through parents are gone too (reviewFindings, chat messages, tokens, skipped files).
  expect(await t.run(async (ctx) => [(await ctx.db.query("reviewFindings").collect()).length, (await ctx.db.query("chatMessages").collect()).length, (await ctx.db.query("oauthTokens").collect()).length, (await ctx.db.query("indexSkippedFiles").collect()).length])).toEqual([1, 1, 1, 1]);
  // The other workspace is untouched, files included; the owner's account remains.
  expect(await owned(t, rival.organizationId, rival.repo._id)).toEqual(rivalBefore);
  expect(await t.run(async (ctx) => (await Promise.all(rival.storage.map((id) => ctx.storage.get(id)))).every(Boolean))).toBe(true);
  expect(await t.run((ctx) => ctx.db.get(acme.userId))).not.toBeNull();
  // Re-running a finished purge does nothing.
  await t.mutation(internal.dataControls.purge, { deletionId: receipt._id });
  expect(await owned(t, rival.organizationId, rival.repo._id)).toEqual(rivalBefore);
});

test("a workspace with a subscription that has not ended cannot be deleted, even if it subscribes during the grace period", async () => {
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 531, "Acme");
  const accountId = await t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId: acme.organizationId, customerId: "cus_1", subscriptionId: "sub_1", status: "active", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));
  const request = () => t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  // Active, and still active while a cancellation waits for the period end.
  await expect(request()).rejects.toThrow(/Cancel it in Settings → Billing → Manage billing/);
  await t.run((ctx) => ctx.db.patch(accountId, { status: "past_due" }));
  await expect(request()).rejects.toThrow(/subscription/);
  // Once Stripe has ended it, deletion can be scheduled.
  await t.run((ctx) => ctx.db.patch(accountId, { status: "canceled" }));
  await request();
  // Subscribing again during the grace period cancels the deletion when the purge would start.
  await t.run((ctx) => ctx.db.patch(accountId, { subscriptionId: "sub_2", status: "active" }));
  vi.setSystemTime(Date.UTC(2026, 9, 21, 12, 1));
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect((await t.run((ctx) => ctx.db.query("workspaceDeletions").collect())).map((d) => d.status)).toEqual(["cancelled"]);
  expect(await t.run((ctx) => ctx.db.get(acme.organizationId))).not.toBeNull();
  expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ subscriptionId: "sub_2", status: "active" });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).some((a) => a.action === "workspace.deletion_blocked")).toBe(true);
});

test("the purge resumes after an interruption: each chunk is a separate transaction and repeated chunks are harmless", async () => {
  process.env.WORKSPACE_DELETION_GRACE_DAYS = "0";
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 511, "Acme"), rival = await workspace(t, 512, "Rival");
  const rivalBefore = await owned(t, rival.organizationId, rival.repo._id);
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  const [deletion] = await t.run((ctx) => ctx.db.query("workspaceDeletions").collect());
  await t.mutation(internal.dataControls.startPurge, { deletionId: deletion._id });
  // Drive the chunks by hand, running some twice (a duplicate schedule after a crash).
  for (let i = 0; i < 400; i++) {
    const d = (await t.run((ctx) => ctx.db.get(deletion._id)))!;
    if (d.status === "done") break;
    await t.mutation(internal.dataControls.purge, { deletionId: deletion._id });
    if (i % 7 === 0) await t.mutation(internal.dataControls.purge, { deletionId: deletion._id });
  }
  expect((await t.run((ctx) => ctx.db.get(deletion._id)))?.status).toBe("done");
  expect(await owned(t, acme.organizationId, acme.repo._id)).toEqual({});
  expect(await owned(t, rival.organizationId, rival.repo._id)).toEqual(rivalBefore);
});

test("retention, data sharing and webhook pruning", async () => {
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 521, "Acme"), rival = await workspace(t, 522, "Rival");
  // Settings are admin-only, validated and audited.
  await expect(t.mutation(api.dataControls.saveSettings, { token: acme.token, organizationId: acme.organizationId, dataSharing: "private", reviewRetentionDays: 3, transcriptRetentionDays: null })).rejects.toThrow(/between 7 and 3,650/);
  await t.mutation(api.dataControls.saveSettings, { token: acme.token, organizationId: acme.organizationId, dataSharing: "aggregate", reviewRetentionDays: 30, transcriptRetentionDays: 14 });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).some((a) => a.action === "workspace.data_settings")).toBe(true);
  // Data sharing: only opted-in workspaces are counted, and only counts leave them.
  const report = await t.query(api.dataControls.aggregateReport, { secret: "data-service" });
  expect([report.workspaces, report.reviews, report.findings, report.byCategory]).toEqual([1, 1, 1, { correctness: 1 }]);
  await expect(t.query(api.dataControls.aggregateReport, { secret: "wrong" })).rejects.toThrow();
  // Retention: 20 days later, transcripts older than 14 days are gone, reviews (30 days) stay.
  vi.setSystemTime(Date.UTC(2026, 10, 3, 12));
  await t.mutation(internal.dataControls.retentionSweep, {});
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const review = await t.run((ctx) => ctx.db.get(acme.reviewId));
  expect([review?.status, review?.agentStateStorageId, await t.run((ctx) => ctx.storage.get(acme.storage[2])), await t.run((ctx) => ctx.db.get(acme.threadId))]).toEqual(["completed", undefined, null, null]);
  // 40 days later the review, its findings and its result file are gone; the other workspace kept everything.
  vi.setSystemTime(Date.UTC(2026, 10, 23, 12));
  await t.mutation(internal.dataControls.retentionSweep, {});
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect(await t.run(async (ctx) => [await ctx.db.get(acme.reviewId), (await ctx.db.query("findings").withIndex("by_org", (q) => q.eq("organizationId", acme.organizationId)).collect()).length, await ctx.storage.get(acme.storage[1])])).toEqual([null, 0, null]);
  expect(await t.run(async (ctx) => [Boolean(await ctx.db.get(rival.reviewId)), Boolean(await ctx.db.get(rival.threadId))])).toEqual([true, true]);
  // Webhook payloads: processed deliveries older than 14 days are pruned with their payloads.
  const [oldPayload, newPayload] = await t.run(async (ctx) => [await ctx.storage.store(new Blob(["{}"])), await ctx.storage.store(new Blob(["{}"]))]);
  await t.run(async (ctx) => {
    await ctx.db.insert("webhookDeliveries", { deliveryId: "old", event: "pull_request", payloadStorageId: oldPayload, status: "completed", attempts: 1, createdAt: Date.now() - 20 * 86_400_000, updatedAt: Date.now() - 20 * 86_400_000 });
    await ctx.db.insert("webhookDeliveries", { deliveryId: "new", event: "pull_request", payloadStorageId: newPayload, status: "completed", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() });
  });
  expect(await t.mutation(internal.dataControls.pruneWebhookPayloads, {})).toBe(1);
  expect(await t.run(async (ctx) => [(await ctx.db.query("webhookDeliveries").collect()).map((d) => d.deliveryId), await ctx.storage.get(oldPayload), Boolean(await ctx.storage.get(newPayload))])).toEqual([["new"], null, true]);
});
