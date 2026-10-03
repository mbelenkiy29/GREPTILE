/**
 * Accepting a "Paste a PR" submission (R3.7). In order, before anything costs money or GitHub quota: the kill switch,
 * strict URL parsing, the proof-of-work, the per-client and global hourly limits and the daily budget (checked and
 * recorded atomically under an advisory lock), then the queued `demo-review` job. Repository and PR size, visibility,
 * and existence are checked by the job with GitHub's API.
 */
import { and, eq, sql } from "drizzle-orm";
import { randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { demoReviews } from "@/lib/db/schema";
import type { DemoEnv } from "@/lib/env";
import type { JobQueue } from "@/lib/jobs/types";
import { log as rootLog, type Logger } from "@/lib/log";
import { checkDemoLimits } from "./limits";
import { DEMO_ORG_ID, ensureDemoOrg } from "./org";
import { verifyPow } from "./pow";
import { parsePrUrl } from "./url";

/** Advisory lock key serializing demo submissions (count + insert). */
const SUBMIT_LOCK = 0x6f72_646d; // "ordm"

export interface SubmitDeps {
  db: Db;
  queue: JobQueue;
  env: DemoEnv;
  /** Signs proof-of-work challenges and client keys (APP_SECRET). */
  secret: string;
  now?: () => Date;
  log?: Logger;
}

export interface SubmitInput {
  url: string;
  challenge: string;
  solution: string;
  /** Keyed hash of the client address (see `clientKey`). */
  clientKey: string;
}

export type SubmitResult =
  | { ok: true; id: string }
  | {
      ok: false;
      status: 400 | 403 | 409 | 429 | 503;
      code: "disabled" | "invalid_url" | "invalid_proof" | "proof_reused" | "rate_limited_client" | "rate_limited_global" | "budget_exhausted";
      message: string;
      retryAfterSec?: number;
    };

const PROOF_MESSAGES = {
  malformed: "The verification step did not complete. Reload the page and try again.",
  signature: "The verification step did not complete. Reload the page and try again.",
  expired: "The verification challenge expired. Try again.",
  difficulty: "The verification challenge is out of date. Reload the page and try again.",
  solution: "The verification step did not complete. Reload the page and try again.",
} as const;

/** Unique-violation on the nonce index: this challenge was already used. */
function isNonceReuse(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown; constraint_name?: unknown }; message?: unknown };
  const code = e?.code ?? e?.cause?.code;
  return code === "23505" || (typeof e?.message === "string" && e.message.includes("demo_reviews_pow_nonce_uq"));
}

export async function submitDemoReview(deps: SubmitDeps, input: SubmitInput): Promise<SubmitResult> {
  const { db, env } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const log = (deps.log ?? rootLog).child({ component: "demo" });
  if (!env.DEMO_ENABLED) return { ok: false, status: 503, code: "disabled", message: "The public demo is turned off on this server." };
  const parsed = parsePrUrl(input.url);
  if (!parsed.ok) return { ok: false, status: 400, code: "invalid_url", message: parsed.error };
  const proof = verifyPow(deps.secret, input.challenge, input.solution, { minDifficulty: env.DEMO_POW_DIFFICULTY, now });
  if (!proof.ok) return { ok: false, status: 403, code: "invalid_proof", message: PROOF_MESSAGES[proof.reason] };

  await ensureDemoOrg(db);
  const id = randomToken(16);
  let outcome: SubmitResult;
  try {
    outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SUBMIT_LOCK})`);
      const verdict = await checkDemoLimits(tx, env, input.clientKey, now);
      if (!verdict.ok) {
        return { ok: false as const, status: verdict.code === "budget_exhausted" ? (503 as const) : (429 as const), code: verdict.code, message: verdict.message, retryAfterSec: verdict.retryAfterSec };
      }
      await tx.insert(demoReviews).values({
        id,
        orgId: DEMO_ORG_ID,
        owner: parsed.ref.owner,
        repo: parsed.ref.repo,
        prNumber: parsed.ref.number,
        clientKey: input.clientKey,
        powNonce: proof.nonce,
        createdAt: now,
      });
      return { ok: true as const, id };
    });
  } catch (err) {
    if (isNonceReuse(err)) return { ok: false, status: 409, code: "proof_reused", message: "That verification was already used. Reload the page and try again." };
    throw err;
  }
  if (!outcome.ok) return outcome;
  try {
    await deps.queue.add("demo-review", { demoId: id }, { jobId: `demo-${id}` });
  } catch (err) {
    await db
      .update(demoReviews)
      .set({ status: "failed", reason: "The demo review could not be queued. Try again later.", finishedAt: new Date() })
      .where(and(eq(demoReviews.orgId, DEMO_ORG_ID), eq(demoReviews.id, id)));
    throw err;
  }
  log.info("demo review queued", { demoId: id, repo: `${parsed.ref.owner}/${parsed.ref.repo}`, prNumber: parsed.ref.number });
  return outcome;
}
