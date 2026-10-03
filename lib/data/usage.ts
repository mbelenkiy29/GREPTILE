/**
 * Usage analytics (R4.3): what an org's reviews, chat, knowledge, and indexing consumed in a period. Every query is
 * tenant-scoped by `orgId` and bounded by `[start, end)` on an indexed `(org_id, created_at)` / `(org_id,
 * queued_at)` column. Sources:
 *
 * - `usage_events` (one row per metered unit of work): credits, and the per-repository / per-author / per-kind
 *   breakdowns.
 * - `model_calls` (one row per model call through the gateway): tokens and estimated cost, per model and per task.
 *   Calls with a review run are review cost; `embed` calls without one are indexing cost; the rest is knowledge,
 *   chat, and other background work.
 * - `review_runs`: completed reviews, their duration and cost.
 */
import { and, asc, count, desc, eq, gt, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { modelCalls, repos, reviewRuns, usageEvents } from "@/lib/db/schema";
import { dateParam, intParam, param, type SearchParams } from "@/lib/ui/url";
import { pageWindow, toPage, type Page, type PageOptions } from "./paginate";
import { scoped } from "./tenant";

const DAY_MS = 86_400_000;
/** Longest custom range the usage page serves (one row per day in the charts). */
export const MAX_RANGE_DAYS = 366;

export const PERIOD_PRESETS = ["this_month", "last_month", "last_30", "last_90", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_30: "Last 30 days",
  last_90: "Last 90 days",
  custom: "Custom range",
};

/** A half-open UTC range `[start, end)`. */
export interface UsageRange {
  preset: PeriodPreset;
  start: Date;
  end: Date;
  label: string;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** First instant of the UTC calendar month containing `d`, shifted by `offset` months. */
export function monthStart(d: Date, offset = 0): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}

/**
 * The range a period selector names. `custom` takes inclusive `YYYY-MM-DD` days (`from`, `to`), clamped to
 * {@link MAX_RANGE_DAYS} and to today; anything invalid falls back to this month.
 */
export function resolveUsageRange(input: { preset?: string; from?: Date; to?: Date }, now: Date = new Date()): UsageRange {
  const preset = (PERIOD_PRESETS as readonly string[]).includes(input.preset ?? "") ? (input.preset as PeriodPreset) : "this_month";
  const tomorrow = new Date(startOfUtcDay(now).getTime() + DAY_MS);
  const label = (start: Date, end: Date) => `${utcDay(start)} – ${utcDay(new Date(end.getTime() - 1))}`;
  const make = (p: PeriodPreset, start: Date, end: Date): UsageRange => ({ preset: p, start, end, label: label(start, end) });
  switch (preset) {
    case "last_month":
      return make(preset, monthStart(now, -1), monthStart(now));
    case "last_30":
      return make(preset, new Date(tomorrow.getTime() - 30 * DAY_MS), tomorrow);
    case "last_90":
      return make(preset, new Date(tomorrow.getTime() - 90 * DAY_MS), tomorrow);
    case "custom": {
      if (!input.from || !input.to) break;
      let start = startOfUtcDay(input.from);
      let end = new Date(startOfUtcDay(input.to).getTime() + DAY_MS);
      if (end > tomorrow) end = tomorrow;
      if (start >= end) break;
      if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) start = new Date(end.getTime() - MAX_RANGE_DAYS * DAY_MS);
      return make(preset, start, end);
    }
    default:
      break;
  }
  return make("this_month", monthStart(now), monthStart(now, 1));
}

const inRange = (col: typeof usageEvents.createdAt | typeof modelCalls.createdAt, r: { start: Date; end: Date }) => and(gte(col, r.start), lt(col, r.end));

const num = (v: unknown) => Number(v ?? 0);
/** Money from Postgres sums, rounded to the 6 decimals costs are stored with. */
const money = (v: unknown) => Math.round(num(v) * 1e6) / 1e6;

export interface UsageSummary {
  /** Completed reviews that finished in the range. */
  reviews: number;
  credits: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD of every priced model call. */
  modelCostUsd: number;
  reviewCostUsd: number;
  indexingCostUsd: number;
  /** Knowledge, chat, and other model work outside reviews and indexing. */
  otherCostUsd: number;
  /** Model calls without a known price (their cost is not included). */
  unpricedCalls: number;
  avgReviewCostUsd: number | null;
  avgReviewDurationMs: number | null;
  /** Distinct pull request authors with a review in the range. */
  activeDevelopers: number;
}

/** Headline numbers for a range. */
export async function usageSummary(db: Db, orgId: string, range: { start: Date; end: Date }): Promise<UsageSummary> {
  const [[events], [calls], [runs]] = await Promise.all([
    db
      .select({
        credits: sql`coalesce(sum(${usageEvents.credits}), 0)`,
        developers: sql`count(distinct ${usageEvents.author}) filter (where ${usageEvents.kind} = 'review')`,
      })
      .from(usageEvents)
      .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range))),
    db
      .select({
        inputTokens: sql`coalesce(sum(${modelCalls.inputTokens}), 0)`,
        outputTokens: sql`coalesce(sum(${modelCalls.outputTokens}), 0)`,
        total: sql`coalesce(sum(${modelCalls.costUsd}), 0)`,
        review: sql`coalesce(sum(${modelCalls.costUsd}) filter (where ${modelCalls.reviewRunId} is not null), 0)`,
        indexing: sql`coalesce(sum(${modelCalls.costUsd}) filter (where ${modelCalls.reviewRunId} is null and ${modelCalls.task} = 'embed'), 0)`,
        unpriced: sql`count(*) filter (where ${modelCalls.costUsd} is null and ${modelCalls.status} <> 'cache_hit')`,
      })
      .from(modelCalls)
      .where(scoped(modelCalls, orgId, inRange(modelCalls.createdAt, range))),
    db
      .select({
        n: count(),
        cost: sql`avg(${reviewRuns.costUsd})`,
        duration: sql`avg(extract(epoch from (${reviewRuns.finishedAt} - ${reviewRuns.startedAt})) * 1000)`,
      })
      .from(reviewRuns)
      .where(
        scoped(
          reviewRuns,
          orgId,
          eq(reviewRuns.status, "completed"),
          // Bounded on the indexed (org_id, queued_at) first: runs finish well within a week of being queued (recovery gives up
          // after 3 attempts).
          gte(reviewRuns.queuedAt, new Date(range.start.getTime() - 7 * DAY_MS)),
          lt(reviewRuns.queuedAt, range.end),
          gte(reviewRuns.finishedAt, range.start),
          lt(reviewRuns.finishedAt, range.end),
        ),
      ),
  ]);
  const total = money(calls?.total);
  const review = money(calls?.review);
  const indexing = money(calls?.indexing);
  return {
    reviews: num(runs?.n),
    credits: num(events?.credits),
    inputTokens: num(calls?.inputTokens),
    outputTokens: num(calls?.outputTokens),
    modelCostUsd: total,
    reviewCostUsd: review,
    indexingCostUsd: indexing,
    otherCostUsd: Math.max(0, money(total - review - indexing)),
    unpricedCalls: num(calls?.unpriced),
    avgReviewCostUsd: runs?.cost === null || runs?.cost === undefined ? null : money(runs.cost),
    avgReviewDurationMs: runs?.duration === null || runs?.duration === undefined ? null : Math.round(num(runs.duration)),
    activeDevelopers: num(events?.developers),
  };
}

export interface UsageDay {
  day: string;
  reviews: number;
  credits: number;
  costUsd: number;
}

/** One row per UTC day of the range (zero-filled): reviews, credits, and estimated model cost. */
export async function usageDaily(db: Db, orgId: string, range: { start: Date; end: Date }): Promise<UsageDay[]> {
  const eventDay = sql<string>`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const callDay = sql<string>`to_char(${modelCalls.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const [events, calls] = await Promise.all([
    db
      .select({
        day: eventDay,
        reviews: sql`count(*) filter (where ${usageEvents.kind} = 'review' and ${usageEvents.credits} > 0)`,
        credits: sql`coalesce(sum(${usageEvents.credits}), 0)`,
      })
      .from(usageEvents)
      .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range)))
      .groupBy(eventDay),
    db
      .select({ day: callDay, cost: sql`coalesce(sum(${modelCalls.costUsd}), 0)` })
      .from(modelCalls)
      .where(scoped(modelCalls, orgId, inRange(modelCalls.createdAt, range)))
      .groupBy(callDay),
  ]);
  const byEvent = new Map(events.map((e) => [e.day, e]));
  const byCall = new Map(calls.map((c) => [c.day, c]));
  const days = Math.min(MAX_RANGE_DAYS + 1, Math.max(0, Math.ceil((range.end.getTime() - range.start.getTime()) / DAY_MS)));
  return Array.from({ length: days }, (_, i) => {
    const day = utcDay(new Date(range.start.getTime() + i * DAY_MS));
    const e = byEvent.get(day);
    return { day, reviews: num(e?.reviews), credits: num(e?.credits), costUsd: money(byCall.get(day)?.cost) };
  });
}

export interface UsageBreakdownRow {
  /** Group key: repository full name, author login, `provider/model`, task, or kind. */
  key: string;
  /** Repository id (by-repository rows). */
  repoId?: number | null;
  reviews: number;
  credits: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Model calls (by-model and by-task rows). */
  calls?: number;
}

const eventTotals = {
  reviews: sql`count(*) filter (where ${usageEvents.kind} = 'review' and ${usageEvents.credits} > 0)`,
  credits: sql`coalesce(sum(${usageEvents.credits}), 0)`,
  inputTokens: sql`coalesce(sum(${usageEvents.inputTokens}), 0)`,
  outputTokens: sql`coalesce(sum(${usageEvents.outputTokens}), 0)`,
  costUsd: sql`coalesce(sum(${usageEvents.costUsd}), 0)`,
  total: sql`count(*) over ()`,
};

const callTotals = {
  calls: count(),
  inputTokens: sql`coalesce(sum(${modelCalls.inputTokens}), 0)`,
  outputTokens: sql`coalesce(sum(${modelCalls.outputTokens}), 0)`,
  costUsd: sql`coalesce(sum(${modelCalls.costUsd}), 0)`,
  total: sql`count(*) over ()`,
};

function eventRow(key: string, r: { reviews: unknown; credits: unknown; inputTokens: unknown; outputTokens: unknown; costUsd: unknown }): UsageBreakdownRow {
  return { key, reviews: num(r.reviews), credits: num(r.credits), inputTokens: num(r.inputTokens), outputTokens: num(r.outputTokens), costUsd: money(r.costUsd) };
}

function callRow(key: string, r: { calls: unknown; inputTokens: unknown; outputTokens: unknown; costUsd: unknown }): UsageBreakdownRow {
  return { key, reviews: 0, credits: 0, calls: num(r.calls), inputTokens: num(r.inputTokens), outputTokens: num(r.outputTokens), costUsd: money(r.costUsd) };
}

function paged<T extends { total: unknown }>(rows: T[], map: (r: T) => UsageBreakdownRow, w: { page: number; pageSize: number }): Page<UsageBreakdownRow> {
  return toPage(rows.map(map), num(rows[0]?.total), w);
}

/** Usage per repository (credits first). Usage without a repository (e.g. org-wide work) is grouped as "(no repository)". */
export async function usageByRepo(db: Db, orgId: string, range: { start: Date; end: Date }, opts: PageOptions = {}): Promise<Page<UsageBreakdownRow>> {
  const w = pageWindow(opts, 10);
  const rows = await db
    .select({ repoId: usageEvents.repoId, fullName: sql<string | null>`max(${repos.fullName})`, ...eventTotals })
    .from(usageEvents)
    .leftJoin(repos, and(eq(repos.id, usageEvents.repoId), eq(repos.orgId, orgId)))
    .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range)))
    .groupBy(usageEvents.repoId)
    .orderBy(desc(eventTotals.credits), desc(eventTotals.costUsd), asc(usageEvents.repoId))
    .limit(w.pageSize)
    .offset(w.offset);
  return paged(rows, (r) => ({ ...eventRow(r.fullName ?? (r.repoId === null ? "(no repository)" : `repository #${r.repoId}`), r), repoId: r.repoId }), w);
}

/** Usage per pull request author (reviews and chat), credits first. */
export async function usageByAuthor(db: Db, orgId: string, range: { start: Date; end: Date }, opts: PageOptions = {}): Promise<Page<UsageBreakdownRow>> {
  const w = pageWindow(opts, 10);
  const rows = await db
    .select({ author: usageEvents.author, ...eventTotals })
    .from(usageEvents)
    .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range), isNotNull(usageEvents.author)))
    .groupBy(usageEvents.author)
    .orderBy(desc(eventTotals.credits), desc(eventTotals.costUsd), asc(usageEvents.author))
    .limit(w.pageSize)
    .offset(w.offset);
  return paged(rows, (r) => eventRow(r.author ?? "", r), w);
}

/** Usage per kind of work (`usage_events.kind`). */
export async function usageByKind(db: Db, orgId: string, range: { start: Date; end: Date }): Promise<UsageBreakdownRow[]> {
  const rows = await db
    .select({ kind: usageEvents.kind, ...eventTotals })
    .from(usageEvents)
    .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range)))
    .groupBy(usageEvents.kind)
    .orderBy(desc(eventTotals.credits), desc(eventTotals.costUsd), asc(usageEvents.kind));
  return rows.map((r) => eventRow(r.kind, r));
}

/** Model calls per provider and model, cost first. */
export async function usageByModel(db: Db, orgId: string, range: { start: Date; end: Date }, opts: PageOptions = {}): Promise<Page<UsageBreakdownRow>> {
  const w = pageWindow(opts, 10);
  const rows = await db
    .select({ provider: modelCalls.provider, model: modelCalls.model, ...callTotals })
    .from(modelCalls)
    .where(scoped(modelCalls, orgId, inRange(modelCalls.createdAt, range)))
    .groupBy(modelCalls.provider, modelCalls.model)
    .orderBy(desc(callTotals.costUsd), desc(callTotals.calls), asc(modelCalls.model))
    .limit(w.pageSize)
    .offset(w.offset);
  return paged(rows, (r) => callRow(`${r.provider}/${r.model}`, r), w);
}

/** Model calls per task (review, verify, summary, chat, knowledge, embed, ...), cost first. */
export async function usageByTask(db: Db, orgId: string, range: { start: Date; end: Date }, opts: PageOptions = {}): Promise<Page<UsageBreakdownRow>> {
  const w = pageWindow(opts, 10);
  const rows = await db
    .select({ task: modelCalls.task, ...callTotals })
    .from(modelCalls)
    .where(scoped(modelCalls, orgId, inRange(modelCalls.createdAt, range)))
    .groupBy(modelCalls.task)
    .orderBy(desc(callTotals.costUsd), desc(callTotals.calls), asc(modelCalls.task))
    .limit(w.pageSize)
    .offset(w.offset);
  return paged(rows, (r) => callRow(r.task, r), w);
}

/** The range named by the usage page's query string (`period`, and `from` / `to` for a custom range). */
export function usageRangeFromQuery(sp: SearchParams, now: Date = new Date()): UsageRange {
  return resolveUsageRange({ preset: param(sp, "period"), from: dateParam(sp, "from"), to: dateParam(sp, "to") }, now);
}

/** Everything the usage page shows for a range; each breakdown pages on its own query parameter. */
export async function loadUsagePage(db: Db, orgId: string, sp: SearchParams, now: Date = new Date()) {
  const range = usageRangeFromQuery(sp, now);
  const [summary, daily, byRepo, byAuthor, byModel, byTask, byKind] = await Promise.all([
    usageSummary(db, orgId, range),
    usageDaily(db, orgId, range),
    usageByRepo(db, orgId, range, { page: intParam(sp, "repoPage") }),
    usageByAuthor(db, orgId, range, { page: intParam(sp, "authorPage") }),
    usageByModel(db, orgId, range, { page: intParam(sp, "modelPage") }),
    usageByTask(db, orgId, range, { page: intParam(sp, "taskPage") }),
    usageByKind(db, orgId, range),
  ]);
  return { range, summary, daily, byRepo, byAuthor, byModel, byTask, byKind };
}

// ---- period totals (caps, alerts, billing)

export interface PeriodTotals {
  credits: number;
  costUsd: number;
}

/** Credits used and estimated model cost in `[start, end)`: what caps and alerts compare against. */
export async function periodTotals(db: Db, orgId: string, range: { start: Date; end: Date }): Promise<PeriodTotals> {
  const [[events], [calls]] = await Promise.all([
    db
      .select({ credits: sql`coalesce(sum(${usageEvents.credits}), 0)` })
      .from(usageEvents)
      .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range))),
    db
      .select({ cost: sql`coalesce(sum(${modelCalls.costUsd}), 0)` })
      .from(modelCalls)
      .where(scoped(modelCalls, orgId, inRange(modelCalls.createdAt, range))),
  ]);
  return { credits: num(events?.credits), costUsd: money(calls?.cost) };
}

/**
 * Active developers (R4.2): distinct pull request authors with a review recorded in `[start, end)`, in the order
 * they first became active (the free plan reviews only the first).
 */
export async function activeDevelopers(db: Db, orgId: string, range: { start: Date; end: Date }): Promise<string[]> {
  const first = sql`min(${usageEvents.id})`;
  const rows = await db
    .select({ author: usageEvents.author })
    .from(usageEvents)
    .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range), eq(usageEvents.kind, "review"), isNotNull(usageEvents.author), gt(usageEvents.credits, 0)))
    .groupBy(usageEvents.author)
    .orderBy(asc(first));
  return rows.map((r) => r.author!).filter(Boolean);
}

// ---- CSV export

const CSV_HEADER = ["created_at", "kind", "repository", "pr_number", "author", "credits", "input_tokens", "output_tokens", "cost_usd"];

/**
 * One CSV cell: quoted when needed, and cells a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR) are
 * prefixed with `'` (author logins and repository names are external input).
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The range's usage events as CSV lines (header first), oldest first, read in keyset-paginated batches so an export
 * never holds the whole period in memory.
 */
export async function* usageCsv(db: Db, orgId: string, range: { start: Date; end: Date }, batchSize = 1000): AsyncGenerator<string> {
  yield `${CSV_HEADER.join(",")}\r\n`;
  let after = 0;
  for (;;) {
    const rows = await db
      .select({
        id: usageEvents.id,
        createdAt: usageEvents.createdAt,
        kind: usageEvents.kind,
        repo: repos.fullName,
        prNumber: usageEvents.prNumber,
        author: usageEvents.author,
        credits: usageEvents.credits,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        costUsd: usageEvents.costUsd,
      })
      .from(usageEvents)
      .leftJoin(repos, and(eq(repos.id, usageEvents.repoId), eq(repos.orgId, orgId)))
      .where(scoped(usageEvents, orgId, inRange(usageEvents.createdAt, range), gt(usageEvents.id, after)))
      .orderBy(asc(usageEvents.id))
      .limit(batchSize);
    if (!rows.length) return;
    yield rows
      .map(
        (r) =>
          [r.createdAt.toISOString(), r.kind, r.repo ?? "", r.prNumber, r.author ?? "", r.credits, r.inputTokens, r.outputTokens, r.costUsd === null ? "" : r.costUsd.toFixed(6)]
            .map(csvCell)
            .join(",") + "\r\n",
      )
      .join("");
    after = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) return;
  }
}
