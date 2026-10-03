/**
 * Device-code login for the `openreview` CLI (R3.5), modelled on OAuth 2.0 device authorization (RFC 8628):
 *
 * 1. `POST /api/cli/device` — the CLI starts a login and gets a secret `device_code` (only its SHA-256 is stored), a
 *    short `user_code`, and the URL to confirm it at.
 * 2. A signed-in member opens `/cli/activate?code=XXXX-XXXX`, checks the code matches their terminal, picks an org,
 *    and approves (or denies). Server actions carry Next.js's same-origin check, so another site cannot approve.
 * 3. `POST /api/cli/token` — the CLI polls with its device code. Until a decision it gets `authorization_pending`;
 *    polling faster than `interval` gets `slow_down`. The first poll after approval creates an API key named
 *    "CLI on <host>" in the chosen org, with the scopes the approving member's role allows, and returns its token —
 *    exactly once. Later polls get `invalid_grant`.
 *
 * Codes expire after 10 minutes. Both endpoints are unauthenticated, so each is rate-limited per client address.
 */
import { randomInt } from "node:crypto";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { scopesForRole } from "@/lib/api/auth";
import { createApiKeyAudited } from "@/lib/api/key-admin";
import type { RateLimiter } from "@/lib/api/rate-limit";
import { requestMetadata } from "@/lib/auth/sessions";
import { hashToken, randomToken } from "@/lib/crypto";
import { recordAudit } from "@/lib/data/audit";
import { getMembership, isUniqueViolation } from "@/lib/data/orgs";
import type { Db } from "@/lib/db";
import { cliSessions, orgs } from "@/lib/db/schema";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";

export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** Seconds the CLI waits between polls. */
export const POLL_INTERVAL_S = 5;
/** Days a key created by `openreview login` stays valid. */
export const CLI_KEY_TTL_DAYS = 365;
/** Device-code starts per client address per minute. */
export const START_LIMIT_PER_MINUTE = 10;
/** Token polls per client address per minute (several logins may share an address). */
export const POLL_LIMIT_PER_MINUTE = 60;
/** Finished or expired logins are deleted this long after they expire. */
const RETENTION_MS = 24 * 60 * 60_000;

/** No vowels (no accidental words) and no look-alikes (0/O, 1/I/L, 5/S). */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRTVWXZ";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_MARKER = "ordc_";

export type CliSession = typeof cliSessions.$inferSelect;

export interface DeviceDeps {
  db: Db;
  now: () => Date;
  limiter: RateLimiter;
  /** The app's public origin; the verification URL is built from it. */
  appUrl: string;
  log?: Logger;
}

export function generateUserCode(): string {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A user code as typed (any case, with or without the dash or spaces), or null when it cannot be one. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** RFC 8628 style error body. */
function oauthError(error: string, description: string, status = 400, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description, ...extra }, { status, headers: { "cache-control": "no-store", ...headers } });
}

function ok(body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 4096) return null;
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function limited(deps: DeviceDeps, req: Request, bucket: string, limit: number): Promise<Response | null> {
  const ip = requestMetadata(req).ip ?? "unknown";
  const decision = await deps.limiter.hit(`cli:${bucket}:${ip}`, limit, 60_000, deps.now());
  if (decision.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil((decision.resetAt.getTime() - deps.now().getTime()) / 1000));
  return oauthError("slow_down", `Too many requests. Retry in ${retryAfter}s.`, 429, { interval: retryAfter }, { "retry-after": String(retryAfter) });
}

const startBody = z.object({
  /** The machine's hostname, for the key's name. Anything unusual is replaced. */
  clientHost: z.string().max(200).optional(),
});

/** Keeps hostnames readable and harmless in key names and on the confirmation page. */
export function cleanHost(host: string | undefined): string {
  const cleaned = (host ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return cleaned || "unknown host";
}

/** `POST /api/cli/device`: starts a login. */
export async function startDeviceLogin(deps: DeviceDeps, req: Request): Promise<Response> {
  const log = (deps.log ?? rootLog).child({ component: "cli-login" });
  const tooMany = await limited(deps, req, "device", START_LIMIT_PER_MINUTE);
  if (tooMany) return tooMany;
  const parsed = startBody.safeParse(await readJson(req));
  if (!parsed.success) return oauthError("invalid_request", "Send a JSON body like {\"clientHost\": \"my-laptop\"}.");
  const now = deps.now();
  // Housekeeping: drop logins that ended long ago.
  await deps.db.delete(cliSessions).where(lt(cliSessions.expiresAt, new Date(now.getTime() - RETENTION_MS)));

  const deviceCode = `${DEVICE_CODE_MARKER}${randomToken(32)}`;
  const clientHost = cleanHost(parsed.data.clientHost);
  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();
    try {
      await deps.db.insert(cliSessions).values({
        deviceCodeHash: hashToken(deviceCode),
        userCode,
        clientHost,
        clientIp: requestMetadata(req).ip?.slice(0, 64) ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS),
      });
      log.info("CLI login started", { clientHost });
      const base = deps.appUrl.replace(/\/$/, "");
      return ok({
        device_code: deviceCode,
        user_code: formatUserCode(userCode),
        verification_uri: `${base}/cli/activate`,
        verification_uri_complete: `${base}/cli/activate?code=${formatUserCode(userCode)}`,
        expires_in: DEVICE_CODE_TTL_MS / 1000,
        interval: POLL_INTERVAL_S,
      });
    } catch (err) {
      // A user code still held by another login: draw again.
      if (attempt < 5 && isUniqueViolation(err, "cli_sessions_user_code_uq")) continue;
      throw err;
    }
  }
}

const tokenBody = z.object({ device_code: z.string().min(1).max(200) });

/** `POST /api/cli/token`: the CLI's poll. Returns the API key's token once, after approval. */
export async function pollDeviceToken(deps: DeviceDeps, req: Request): Promise<Response> {
  const log = (deps.log ?? rootLog).child({ component: "cli-login" });
  const tooMany = await limited(deps, req, "token", POLL_LIMIT_PER_MINUTE);
  if (tooMany) return tooMany;
  const parsed = tokenBody.safeParse(await readJson(req));
  if (!parsed.success) return oauthError("invalid_request", "Send a JSON body like {\"device_code\": \"…\"}.");
  const now = deps.now();
  const deviceCodeHash = hashToken(parsed.data.device_code);
  const [session] = await deps.db.select().from(cliSessions).where(eq(cliSessions.deviceCodeHash, deviceCodeHash));
  if (!session) return oauthError("invalid_grant", "Unknown device code. Run `openreview login` again.");

  // Polling faster than the interval: tell the CLI to slow down (and count this poll).
  const tooSoon = session.lastPolledAt !== null && now.getTime() - session.lastPolledAt.getTime() < POLL_INTERVAL_S * 1000;
  await deps.db.update(cliSessions).set({ lastPolledAt: now }).where(eq(cliSessions.id, session.id));
  if (session.deliveredAt) return oauthError("invalid_grant", "This login was already completed. Run `openreview login` again.");
  if (session.status === "denied") return oauthError("access_denied", "The login was denied in the browser.");
  if (session.status === "expired" || now.getTime() >= session.expiresAt.getTime()) {
    if (session.status === "pending") await deps.db.update(cliSessions).set({ status: "expired" }).where(and(eq(cliSessions.id, session.id), eq(cliSessions.status, "pending")));
    return oauthError("expired_token", "The login code expired. Run `openreview login` again.");
  }
  if (tooSoon) return oauthError("slow_down", `Poll at most every ${POLL_INTERVAL_S} seconds.`, 400, { interval: POLL_INTERVAL_S * 2 });
  if (session.status === "pending") return oauthError("authorization_pending", "Waiting for you to approve the login in the browser.", 400, { interval: POLL_INTERVAL_S });

  try {
    const issued = await deps.db.transaction(async (tx) => {
      // Claim the delivery: only one poll may create the key.
      const [claimed] = await tx
        .update(cliSessions)
        .set({ deliveredAt: now })
        .where(and(eq(cliSessions.id, session.id), eq(cliSessions.status, "approved"), isNull(cliSessions.deliveredAt), gt(cliSessions.expiresAt, now)))
        .returning();
      if (!claimed || !claimed.orgId || !claimed.userId) return { error: "invalid_grant" as const };
      // The approver may have left the org (or lost their role) since approving.
      const membership = await getMembership(tx, claimed.orgId, claimed.userId);
      if (!membership) return { error: "access_denied" as const };
      const { key, token } = await createApiKeyAudited(
        tx,
        { orgId: claimed.orgId, userId: claimed.userId, ip: requestMetadata(req).ip, now },
        { name: `CLI on ${claimed.clientHost}`, scopes: scopesForRole(membership.role), expiresInDays: CLI_KEY_TTL_DAYS },
      );
      await tx.update(cliSessions).set({ apiKeyId: key.id }).where(eq(cliSessions.id, claimed.id));
      const [org] = await tx.select({ id: orgs.id, name: orgs.name, slug: orgs.slug }).from(orgs).where(eq(orgs.id, claimed.orgId));
      return { key, token, org: org! };
    });
    if ("error" in issued) {
      return issued.error === "access_denied"
        ? oauthError("access_denied", "The approving member is no longer in that organization.")
        : oauthError("invalid_grant", "This login was already completed. Run `openreview login` again.");
    }
    log.info("CLI login completed", { orgId: issued.org.id, keyId: issued.key.id, prefix: issued.key.prefix });
    return ok({
      access_token: issued.token,
      token_type: "bearer",
      scope: issued.key.scopes.join(" "),
      organization: issued.org,
      key: { id: issued.key.id, name: issued.key.name, prefix: issued.key.prefix, expiresAt: issued.key.expiresAt },
    });
  } catch (err) {
    log.error("CLI login could not issue a key", { error: errorMessage(err) });
    throw err;
  }
}

/** A login waiting for a decision, for the confirmation page; undefined when the code is unknown or no longer pending. */
export async function findPendingLogin(db: Db, userCode: string, now: Date): Promise<CliSession | undefined> {
  const [row] = await db
    .select()
    .from(cliSessions)
    .where(and(eq(cliSessions.userCode, userCode), eq(cliSessions.status, "pending"), gt(cliSessions.expiresAt, now)));
  return row;
}

export type DecisionError = "invalid_code" | "not_found" | "not_member";

export const DECISION_ERROR_MESSAGES: Record<DecisionError, string> = {
  invalid_code: "That doesn't look like a login code. Codes look like BCDF-GHJK.",
  not_found: "That code is unknown, expired, or already used. Run `openreview login` again for a new one.",
  not_member: "You're not a member of that organization.",
};

/**
 * Approves (for one of the member's orgs) or denies a pending login. The org comes from the form but is only
 * accepted when the user is a member of it; the key's scopes are decided by their role when the CLI collects it.
 */
export async function decideLogin(
  db: Db,
  input: { userCode: unknown; userId: string; decision: "approve" | "deny"; orgId?: string | null; ip?: string | null; now: Date },
): Promise<{ ok: true; status: "approved" | "denied"; session: CliSession } | { ok: false; error: DecisionError }> {
  const code = normalizeUserCode(input.userCode);
  if (!code) return { ok: false, error: "invalid_code" };
  let orgId: string | null = null;
  if (input.decision === "approve") {
    const membership = input.orgId ? await getMembership(db, input.orgId, input.userId) : undefined;
    if (!membership) return { ok: false, error: "not_member" };
    orgId = membership.id;
  }
  const status = input.decision === "approve" ? ("approved" as const) : ("denied" as const);
  const [row] = await db
    .update(cliSessions)
    .set({ status, userId: input.userId, orgId, decidedAt: input.now })
    .where(and(eq(cliSessions.userCode, code), eq(cliSessions.status, "pending"), gt(cliSessions.expiresAt, input.now), or(isNull(cliSessions.userId), eq(cliSessions.userId, input.userId))))
    .returning();
  if (!row) return { ok: false, error: "not_found" };
  if (orgId) {
    await recordAudit(db, {
      orgId,
      actorType: "user",
      actorId: input.userId,
      action: "cli.login_approved",
      targetType: "cli_session",
      targetId: row.id,
      metadata: { clientHost: row.clientHost, clientIp: row.clientIp },
      ip: input.ip ?? null,
      now: input.now,
    });
  }
  return { ok: true, status, session: row };
}
