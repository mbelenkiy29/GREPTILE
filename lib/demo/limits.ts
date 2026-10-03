/**
 * Demo abuse limits (R3.7): submissions per client per hour, submissions for everyone per hour, and a daily model
 * cost cap. Counts come from the `demo_reviews` table itself (every accepted submission is a row), so the limits
 * hold across web processes without Redis; the cost cap reads the model gateway's records for `org_demo`.
 */
import { isIP } from "node:net";
import { and, count, eq, gte } from "drizzle-orm";
import { hmac } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { demoReviews } from "@/lib/db/schema";
import type { DemoEnv } from "@/lib/env";
import { modelCallTotals } from "@/lib/llm/recorder";
import { DEMO_ORG_ID } from "./org";

export const HOUR_MS = 3_600_000;

/**
 * The client address a request came from. Behind the reverse proxy the last `X-Forwarded-For` hop is the one the
 * proxy itself appended (earlier hops are client-controlled and ignored); `X-Real-IP` is the fallback.
 */
export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  const candidate = forwarded?.at(-1) ?? headers.get("x-real-ip")?.trim() ?? null;
  return candidate && isIP(candidate) ? candidate : null;
}

/**
 * A keyed hash identifying the client for rate limiting (raw addresses are never stored). IPv6 clients are grouped by
 * their /64, which one subscriber usually controls entirely.
 */
export function clientKey(secret: string, address: string | null): string {
  let group = address ?? "unknown";
  if (address && isIP(address) === 6) {
    const full = expandIpv6(address);
    group = full ? `${full.slice(0, 4).join(":")}::/64` : address;
  }
  return hmac(secret, `demo-client:${group}`);
}

function expandIpv6(address: string): string[] | null {
  const [head, tail] = address.toLowerCase().split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (right.at(-1)?.includes(".") || left.at(-1)?.includes(".")) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((p) => p.padStart(4, "0"));
}

export type LimitVerdict = { ok: true } | { ok: false; code: "rate_limited_client" | "rate_limited_global" | "budget_exhausted"; message: string; retryAfterSec: number };

/** Start of the UTC day containing `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Estimated model spend of the demo today (UTC), from `model_calls`. */
export async function demoSpendToday(db: Db, now: Date): Promise<number> {
  const totals = await modelCallTotals(db, DEMO_ORG_ID, { since: utcDayStart(now) });
  return totals.costUsd;
}

/** The daily cost cap alone (also checked by the job before it spends anything). */
export async function checkDemoBudget(db: Db, env: Pick<DemoEnv, "DEMO_DAILY_COST_USD">, now: Date): Promise<LimitVerdict> {
  const spent = await demoSpendToday(db, now);
  if (spent < env.DEMO_DAILY_COST_USD) return { ok: true };
  const tomorrow = utcDayStart(now).getTime() + 24 * HOUR_MS;
  return {
    ok: false,
    code: "budget_exhausted",
    message: "Today's demo budget has been used up. Try again tomorrow, or install OpenReview to review your own pull requests.",
    retryAfterSec: Math.ceil((tomorrow - now.getTime()) / 1000),
  };
}

/** Whether one more submission from `key` fits the per-client and global hourly limits and the daily budget. */
export async function checkDemoLimits(
  db: Db,
  env: Pick<DemoEnv, "DEMO_PER_IP_PER_HOUR" | "DEMO_GLOBAL_PER_HOUR" | "DEMO_DAILY_COST_USD">,
  key: string,
  now: Date,
): Promise<LimitVerdict> {
  const since = new Date(now.getTime() - HOUR_MS);
  const [[mine], [all]] = await Promise.all([
    db.select({ n: count() }).from(demoReviews).where(and(eq(demoReviews.orgId, DEMO_ORG_ID), eq(demoReviews.clientKey, key), gte(demoReviews.createdAt, since))),
    db.select({ n: count() }).from(demoReviews).where(and(eq(demoReviews.orgId, DEMO_ORG_ID), gte(demoReviews.createdAt, since))),
  ]);
  if ((mine?.n ?? 0) >= env.DEMO_PER_IP_PER_HOUR) {
    return { ok: false, code: "rate_limited_client", message: `You can run ${env.DEMO_PER_IP_PER_HOUR} demo reviews per hour. Try again later.`, retryAfterSec: 3600 };
  }
  if ((all?.n ?? 0) >= env.DEMO_GLOBAL_PER_HOUR) {
    return { ok: false, code: "rate_limited_global", message: "The demo is busy right now. Try again in a little while.", retryAfterSec: 900 };
  }
  return checkDemoBudget(db, env, now);
}
