import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { audit, authorize, service } from "./auth";
import { openSubscription } from "../src/billing";

// Data controls (M3): data sharing (private by default), retention for reviews and transcripts, and
// owner-only workspace deletion with a grace period followed by a resumable purge of every
// workspace-owned table, including the files those rows reference.

// ---- The purge plan. Every table is either reached from the workspace here or listed as not
// workspace-owned below (a test fails otherwise).
type Step =
  | { table: TableNames; via: "org"; index: string }
  | { table: TableNames; via: "repo"; index: string; field?: "repositoryId" }
  | { table: TableNames; via: "repoChild"; parent: { table: TableNames; index: string }; index: string; field: string }
  | { table: TableNames; via: "child"; parent: { table: TableNames; index: string }; index: string; field: string }
  | { table: TableNames; via: "scan"; match: "organizationId" | "repositoryOrConnection" }
  | { table: "organizations"; via: "self" };
const reviews = { table: "reviews" as const, index: "by_org" };
export const purgePlan: Step[] = [
  // Children first, while their parents can still be found from the workspace.
  ...(["reviewFindings", "reviewRuns", "agentRuns", "modelCalls", "reviewComments", "featureTips", "fixRequests"] as const).map((table) => ({ table, via: "child" as const, parent: reviews, index: "by_review", field: "reviewId" })),
  { table: "chatMessages", via: "child", parent: { table: "chatThreads", index: "by_org_user" }, index: "by_thread", field: "threadId" },
  { table: "pullRequestCommits", via: "child", parent: { table: "pullRequests", index: "by_org" }, index: "by_pr", field: "pullRequestId" },
  { table: "oauthTokens", via: "child", parent: { table: "oauthGrants", index: "by_org" }, index: "by_grant", field: "grantId" },
  { table: "ssoAssertions", via: "child", parent: { table: "ssoConnections", index: "by_org" }, index: "by_assertion", field: "connectionId" },
  { table: "ssoDomains", via: "child", parent: { table: "ssoConnections", index: "by_org" }, index: "by_connection", field: "connectionId" },
  { table: "integrationRevocations", via: "child", parent: { table: "integrationConnections", index: "by_org" }, index: "by_connection", field: "connectionId" },
  { table: "providerEvents", via: "child", parent: { table: "providerConnections", index: "by_org" }, index: "by_connection_created", field: "connectionId" },
  { table: "providerIdentities", via: "child", parent: { table: "providerConnections", index: "by_org" }, index: "by_connection_user", field: "connectionId" },
  { table: "teamMembers", via: "child", parent: { table: "teams", index: "by_org" }, index: "by_team", field: "teamId" },
  { table: "indexSkippedFiles", via: "repoChild", parent: { table: "indexJobs", index: "by_repo" }, index: "by_job_path", field: "jobId" },
  // Per repository.
  ...([["repositorySettings", "by_repo"], ["repositoryFiles", "by_repo"], ["graphModuleReferences", "by_path"], ["symbols", "by_repo"], ["relationships", "by_repo"], ["indexJobs", "by_repo"], ["knowledgeEntries", "by_repo"], ["pullCatalogJobs", "by_repo"], ["codeChunks", "by_file"], ["embeddings", "by_path"], ["chunkEmbeddings", "by_path"], ["conversations", "by_pr"], ["p4Identities", "by_repo_user"]] as const).map(([table, index]) => ({ table, via: "repo" as const, index })),
  // Small tables without a workspace index.
  ...(["providerInstallRequests", "notificationDeliveries", "oauthCodes", "bridgeDevices"] as const).map((table) => ({ table, via: "scan" as const, match: "organizationId" as const })),
  { table: "providerIdentityGrants", via: "scan", match: "repositoryOrConnection" },
  // Workspace-indexed tables; repositories and members near the end, the audit log last.
  ...([["integrationConnections", "by_org"], ["approvalPolicies", "by_org"], ["approvalJobs", "by_org_status"], ["runtimePolicies", "by_org"], ["runtimeWorkers", "by_org"], ["runtimeJobs", "by_org_status"], ["p4Polls", "by_org"], ["providerConnections", "by_org"], ["scopeSettings", "by_org"], ["repositoryClusters", "by_org"], ["clusterSuggestions", "by_org_status"], ["modelCache", "by_key"], ["ssoConnections", "by_org"], ["emailInvitations", "by_org"], ["analyticsDaily", "by_org_day"], ["invitations", "by_org"], ["pullRequests", "by_org"], ["findings", "by_org"], ["reviews", "by_org"], ["billingAccounts", "by_org"], ["billingUsage", "by_org_period"], ["notificationChannels", "by_org"], ["slackInstallations", "by_org"], ["notificationPreferences", "by_org"], ["chatThreads", "by_org_user"], ["learnedRules", "by_org"], ["commentReactions", "by_org_time"], ["findingFeedback", "by_org"], ["findingSignals", "by_org_time"], ["learnedPreferences", "by_org_scope"], ["customRules", "by_org"], ["ruleSuggestions", "by_org_status"], ["ruleAssistantRuns", "by_org_time"], ["usageEvents", "by_org"], ["oauthGrants", "by_org"], ["apiKeys", "by_org"], ["teams", "by_org"], ["githubInstallations", "by_org"], ["repositories", "by_org"], ["organizationMembers", "by_org"], ["auditEvents", "by_org"]] as const).map(([table, index]) => ({ table, via: "org" as const, index })),
  { table: "organizations", via: "self" },
];
// Not owned by a workspace: kept on deletion, with the reason.
export const sharedTables: Partial<Record<TableNames, string>> = {
  users: "personal account; may belong to other workspaces", identities: "personal sign-in methods", sessions: "personal browser sessions",
  personalCredentials: "personal agent keys", personalSettings: "personal preferences", cliSessions: "personal CLI sessions", loginTokens: "magic-link tokens keyed by email",
  inferenceBudgets: "deployment-wide model budget", inferenceReservations: "deployment-wide budget reservations",
  rateLimits: "short-lived counters", providerReceipts: "one-time install receipts that expire", ssoRequests: "SAML request ids that expire in 10 minutes",
  oauthClients: "MCP client registry shared by all workspaces", stripeEvents: "Stripe event ids kept for replay protection (no review data)",
  slackEventReceipts: "Slack event-id dedupe", webhookDeliveries: "provider payloads not linked to a workspace; pruned deployment-wide after 14 days",
  workspaceDeletions: "deletion receipts",
};

// Files referenced by a row (any v.id("_storage") field, at any depth), deleted with it.
type ValidatorJson = { kind: string; tableName?: string; fields?: Record<string, ValidatorJson>; element?: ValidatorJson; members?: ValidatorJson[]; value?: ValidatorJson };
function storageIds(validator: ValidatorJson | undefined, value: unknown, out: string[] = []): string[] {
  if (!validator || value === undefined || value === null) return out;
  if (validator.kind === "id" && validator.tableName === "_storage" && typeof value === "string") out.push(value);
  else if (validator.kind === "object" && typeof value === "object") for (const [k, f] of Object.entries(validator.fields ?? {})) storageIds(f, (value as Record<string, unknown>)[k], out);
  else if (validator.kind === "array" && Array.isArray(value)) for (const item of value) storageIds(validator.element, item, out);
  else if (validator.kind === "union") for (const m of validator.members ?? []) storageIds(m, value, out);
  else if (validator.kind === "record" && typeof value === "object") for (const item of Object.values(value as object)) storageIds(validator.value, item, out);
  return out;
}
const tableValidator = (table: TableNames) => (schema as unknown as { tables: Record<string, { validator: ValidatorJson }> }).tables[table]?.validator;
async function remove(ctx: MutationCtx, table: TableNames, doc: { _id: string } & Record<string, unknown>) {
  for (const id of [...new Set(storageIds(tableValidator(table), doc))]) await ctx.storage.delete(id as Id<"_storage">).catch(() => undefined);
  await ctx.db.delete(doc._id as Id<TableNames>);
}

// Dynamic table access for the plan (table and index names come from the typed plan above).
type AnyQuery = { withIndex(index: string, f: (q: { eq(field: string, value: unknown): unknown }) => unknown): AnyQuery; take(n: number): Promise<({ _id: string } & Record<string, unknown>)[]>; paginate(o: { cursor: string | null; numItems: number }): Promise<{ page: ({ _id: string } & Record<string, unknown>)[]; isDone: boolean; continueCursor: string }> };
const table = (ctx: MutationCtx, name: TableNames) => (ctx.db.query as unknown as (t: string) => AnyQuery)(name);
const byField = (ctx: MutationCtx, name: TableNames, index: string, field: string, value: unknown) => table(ctx, name).withIndex(index, (q) => q.eq(field, value));
const BATCH = 200;
type StepResult = { deleted: number; done: boolean; cursor?: string };
async function runStep(ctx: MutationCtx, organizationId: Id<"organizations">, step: Step, cursor: string | null): Promise<StepResult> {
  if (step.via === "self") { const org = await ctx.db.get(organizationId); if (org) { await remove(ctx, "organizations", org as never); return { deleted: 1, done: true }; } return { deleted: 0, done: true }; }
  if (step.via === "org") {
    const rows = await byField(ctx, step.table, step.index, "organizationId", organizationId).take(BATCH);
    for (const r of rows) await remove(ctx, step.table, r);
    return { deleted: rows.length, done: rows.length < BATCH };
  }
  if (step.via === "repo" || step.via === "repoChild") {
    for (const repo of await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).take(2000)) {
      let rows: ({ _id: string } & Record<string, unknown>)[] = [];
      if (step.via === "repo") rows = await byField(ctx, step.table, step.index, "repositoryId", repo._id).take(BATCH);
      else for (const parent of await byField(ctx, step.parent.table, step.parent.index, "repositoryId", repo._id).take(500)) { rows = await byField(ctx, step.table, step.index, step.field, parent._id).take(BATCH); if (rows.length) break; }
      if (rows.length) { for (const r of rows) await remove(ctx, step.table, r); return { deleted: rows.length, done: false }; }
    }
    return { deleted: 0, done: true };
  }
  if (step.via === "child") {
    const page = await byField(ctx, step.parent.table, step.parent.index, "organizationId", organizationId).paginate({ cursor, numItems: 25 });
    let deleted = 0;
    for (const parent of page.page) {
      const rows = await byField(ctx, step.table, step.index, step.field, parent._id).take(BATCH);
      for (const r of rows) await remove(ctx, step.table, r);
      deleted += rows.length;
      if (rows.length === BATCH) return { deleted, done: false, ...(cursor ? { cursor } : {}) }; // more children: revisit this page
    }
    return page.isDone ? { deleted, done: true } : { deleted, done: false, cursor: page.continueCursor };
  }
  // Bounded scans of small tables.
  const page = await table(ctx, step.table).paginate({ cursor, numItems: BATCH });
  const repos = step.match === "repositoryOrConnection" ? new Set((await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).take(2000)).map((r) => r._id as string)) : null;
  const connections = step.match === "repositoryOrConnection" ? new Set((await ctx.db.query("providerConnections").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).take(500)).map((c) => c._id as string)) : null;
  const mine = page.page.filter((r) => step.match === "organizationId" ? r.organizationId === organizationId : repos!.has(r.repositoryId as string) || connections!.has(r.connectionId as string));
  for (const r of mine) await remove(ctx, step.table, r);
  return page.isDone ? { deleted: mine.length, done: true } : { deleted: mine.length, done: false, cursor: page.continueCursor };
}

// ---- Workspace deletion: owner-only, cancellable during the grace period, then purged in steps.
const graceDays = () => { const n = Number(process.env.WORKSPACE_DELETION_GRACE_DAYS); return Number.isFinite(n) && n >= 0 && n <= 90 ? n : 7; };
// A workspace with a subscription that has not ended cannot be deleted: the purge would drop its
// billing link while Stripe kept charging. The owner cancels in Manage billing first.
const subscribed = async (ctx: { db: MutationCtx["db"] }, organizationId: Id<"organizations">) => openSubscription(await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).unique());
const pendingOf = (ctx: { db: MutationCtx["db"] }, organizationId: Id<"organizations">) => ctx.db.query("workspaceDeletions").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).order("desc").first();
export const requestDeletion = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), confirmName: v.string() }, handler: async (ctx, a) => {
  const { user, member } = await authorize(ctx, a.token, a.organizationId);
  if (member.role !== "owner") throw new Error("Only the workspace owner can delete it");
  const org = await ctx.db.get(a.organizationId);
  if (!org || a.confirmName.trim() !== org.name) throw new Error("Type the workspace name exactly to confirm");
  const pending = await pendingOf(ctx, a.organizationId);
  if (pending && ["scheduled", "purging"].includes(pending.status)) throw new Error("Deletion is already scheduled");
  if (await subscribed(ctx, a.organizationId)) throw new Error("This workspace has a subscription. Cancel it in Settings → Billing → Manage billing, then delete the workspace once the subscription has ended.");
  const scheduledFor = Date.now() + graceDays() * 86_400_000;
  const id = await ctx.db.insert("workspaceDeletions", { organizationId: a.organizationId, name: org.name, requestedBy: user._id, requestedAt: Date.now(), scheduledFor, status: "scheduled", step: 0, counts: {} });
  const scheduledId = await ctx.scheduler.runAt(scheduledFor, internal.dataControls.startPurge, { deletionId: id });
  await ctx.db.patch(id, { scheduledId });
  await audit(ctx, a.organizationId, user._id, "workspace.deletion_requested", new Date(scheduledFor).toISOString());
  return { scheduledFor };
} });
export const cancelDeletion = mutation({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user, member } = await authorize(ctx, a.token, a.organizationId);
  if (member.role !== "owner") throw new Error("Only the workspace owner can cancel deletion");
  const pending = await pendingOf(ctx, a.organizationId);
  if (!pending || pending.status !== "scheduled") throw new Error("No deletion is waiting");
  if (pending.scheduledId) await ctx.scheduler.cancel(pending.scheduledId);
  await ctx.db.patch(pending._id, { status: "cancelled", cancelledAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, "workspace.deletion_cancelled", pending._id);
} });
export const startPurge = internalMutation({ args: { deletionId: v.id("workspaceDeletions") }, handler: async (ctx, a) => {
  const d = await ctx.db.get(a.deletionId);
  if (!d || d.status !== "scheduled" || d.scheduledFor > Date.now()) return;
  // Subscribed during the grace period: keep the workspace and its billing link.
  if (await subscribed(ctx, d.organizationId)) {
    await ctx.db.patch(d._id, { status: "cancelled", cancelledAt: Date.now() });
    await audit(ctx, d.organizationId, undefined, "workspace.deletion_blocked", "subscription");
    return;
  }
  await audit(ctx, d.organizationId, undefined, "workspace.purge_started", d._id);
  await ctx.db.patch(d._id, { status: "purging", startedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.dataControls.purge, { deletionId: d._id });
} });
// One bounded chunk per transaction; the receipt holds the step and cursor, so a crash or redeploy
// resumes where it stopped, and re-running a finished step deletes nothing.
export const purge = internalMutation({ args: { deletionId: v.id("workspaceDeletions") }, handler: async (ctx, a) => {
  const d = await ctx.db.get(a.deletionId);
  if (!d || d.status !== "purging") return;
  const step = purgePlan[d.step];
  if (!step) { await ctx.db.patch(d._id, { status: "done", completedAt: Date.now(), cursor: undefined }); return; }
  const result = await runStep(ctx, d.organizationId, step, d.cursor ?? null);
  const counts = { ...d.counts, ...(result.deleted ? { [step.table]: (d.counts[step.table] ?? 0) + result.deleted } : {}) };
  await ctx.db.patch(d._id, result.done ? { step: d.step + 1, cursor: undefined, counts } : { cursor: result.cursor, counts });
  await ctx.scheduler.runAfter(0, internal.dataControls.purge, { deletionId: d._id });
} });

// ---- Settings: data sharing and retention (admins, audited).
export const settings = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { member } = await authorize(ctx, a.token, a.organizationId);
  const org = await ctx.db.get(a.organizationId);
  const deletion = await ctx.db.query("workspaceDeletions").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).order("desc").first();
  return { role: member.role, name: org?.name ?? "", dataSharing: org?.dataSharing ?? "private", reviewRetentionDays: org?.reviewRetentionDays ?? null, transcriptRetentionDays: org?.transcriptRetentionDays ?? null, graceDays: graceDays(), deletion: deletion && ["scheduled", "purging"].includes(deletion.status) ? { status: deletion.status, scheduledFor: deletion.scheduledFor } : null };
} });
const days = v.union(v.number(), v.null());
export const saveSettings = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), dataSharing: v.union(v.literal("private"), v.literal("aggregate")), reviewRetentionDays: days, transcriptRetentionDays: days }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  for (const n of [a.reviewRetentionDays, a.transcriptRetentionDays]) if (n !== null && (!Number.isInteger(n) || n < 7 || n > 3650)) throw new Error("Retention is between 7 and 3,650 days, or unlimited");
  await ctx.db.patch(a.organizationId, { dataSharing: a.dataSharing, reviewRetentionDays: a.reviewRetentionDays ?? undefined, transcriptRetentionDays: a.transcriptRetentionDays ?? undefined });
  await audit(ctx, a.organizationId, user._id, "workspace.data_settings", `${a.dataSharing};reviews=${a.reviewRetentionDays ?? "unlimited"};transcripts=${a.transcriptRetentionDays ?? "unlimited"}`);
} });

// ---- Retention: daily sweep; each workspace is processed in bounded steps.
async function removeReview(ctx: MutationCtx, review: Doc<"reviews">) {
  for (const t of ["reviewFindings", "reviewRuns", "agentRuns", "modelCalls", "reviewComments", "featureTips", "fixRequests", "runtimeJobs", "approvalJobs"] as const)
    for (const r of await byField(ctx, t, "by_review", "reviewId", review._id).take(1000)) await remove(ctx, t, r);
  for (const f of await ctx.db.query("findings").withIndex("by_review", (q) => q.eq("reviewId", review._id)).take(1000)) {
    for (const t of ["findingFeedback", "commentReactions", "findingSignals"] as const) for (const r of await byField(ctx, t, "by_finding", "findingId", f._id).take(1000)) await remove(ctx, t, r);
    await remove(ctx, "findings", f as never);
  }
  await remove(ctx, "reviews", review as never);
}
export const retentionSweep = internalMutation({ args: {}, handler: async (ctx) => {
  let n = 0;
  for (const org of await ctx.db.query("organizations").take(5000)) if (org.reviewRetentionDays || org.transcriptRetentionDays) { await ctx.scheduler.runAfter(n++ * 1000, internal.dataControls.retention, { organizationId: org._id }); }
  return n;
} });
export const retention = internalMutation({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<{ reviews: number; transcripts: number; more: boolean }> => {
  const org = await ctx.db.get(a.organizationId);
  if (!org) return { reviews: 0, transcripts: 0, more: false };
  let reviewsDeleted = 0, transcripts = 0;
  if (org.reviewRetentionDays) {
    const cutoff = Date.now() - org.reviewRetentionDays * 86_400_000;
    for (const r of await ctx.db.query("reviews").withIndex("by_org_time", (q) => q.eq("organizationId", org._id).lt("createdAt", cutoff)).take(20)) { await removeReview(ctx, r); reviewsDeleted++; }
  }
  if (org.transcriptRetentionDays) {
    const cutoff = Date.now() - org.transcriptRetentionDays * 86_400_000;
    for (const r of await ctx.db.query("reviews").withIndex("by_org_time", (q) => q.eq("organizationId", org._id).lt("createdAt", cutoff)).take(500)) if (r.agentStateStorageId) { await ctx.storage.delete(r.agentStateStorageId).catch(() => undefined); await ctx.db.patch(r._id, { agentStateStorageId: undefined }); transcripts++; }
    for (const thread of (await ctx.db.query("chatThreads").withIndex("by_org_user", (q) => q.eq("organizationId", org._id)).take(500)).filter((t) => t.updatedAt < cutoff).slice(0, 20)) {
      for (const m of await ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", thread._id)).take(1000)) await remove(ctx, "chatMessages", m as never);
      await remove(ctx, "chatThreads", thread as never); transcripts++;
    }
    for (const repo of await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", org._id)).take(2000))
      for (const c of (await ctx.db.query("conversations").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id)).take(500)).filter((c) => (c.updatedAt ?? c.createdAt) < cutoff).slice(0, 50)) { await remove(ctx, "conversations", c as never); transcripts++; }
  }
  const more = reviewsDeleted === 20 || transcripts >= 20;
  if (more) await ctx.scheduler.runAfter(0, internal.dataControls.retention, a);
  return { reviews: reviewsDeleted, transcripts, more };
} });
// Webhook payloads carry no workspace link; processed deliveries are pruned after 14 days.
export const pruneWebhookPayloads = internalMutation({ args: {}, handler: async (ctx) => {
  const cutoff = Date.now() - 14 * 86_400_000;
  const old = (await ctx.db.query("webhookDeliveries").withIndex("by_status", (q) => q.eq("status", "completed")).take(500)).filter((d) => d.updatedAt < cutoff).slice(0, 200);
  for (const d of old) await remove(ctx, "webhookDeliveries", d as never);
  return old.length;
} });

// ---- Data sharing: the only cross-workspace read. Workspaces are private unless an admin opted in;
// only counts leave the workspace, never code, titles or text.
async function sharedAggregate(ctx: QueryCtx) {
  const sharing = (await ctx.db.query("organizations").take(5000)).filter((o) => o.dataSharing === "aggregate");
  const totals = { workspaces: sharing.length, reviews: 0, findings: 0, byCategory: {} as Record<string, number>, bySeverity: {} as Record<string, number> };
  for (const org of sharing) {
    totals.reviews += (await ctx.db.query("reviews").withIndex("by_org", (q) => q.eq("organizationId", org._id)).take(10_000)).length;
    for (const f of await ctx.db.query("findings").withIndex("by_org", (q) => q.eq("organizationId", org._id)).take(10_000)) { totals.findings++; totals.byCategory[f.category] = (totals.byCategory[f.category] ?? 0) + 1; totals.bySeverity[f.severity] = (totals.bySeverity[f.severity] ?? 0) + 1; }
  }
  return totals;
}
// Operator report (backend secret), e.g. `scripts/aggregate-report.ts`.
export const aggregateReport = query({ args: { secret: v.string() }, handler: async (ctx, a) => { service(a.secret); return sharedAggregate(ctx); } });
