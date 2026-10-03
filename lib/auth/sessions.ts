import { and, eq, inArray, lt } from "drizzle-orm";
import { hashToken, randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { getMembership } from "@/lib/data/orgs";
import { sessions, users } from "@/lib/db/schema";
import { readCookie, SESSION_COOKIE } from "./cookies";

/**
 * Database-backed sessions (R6.1). The browser holds a random 32-byte token; the `sessions` row is keyed by its
 * SHA-256, so a database leak does not yield usable cookies. Sessions expire after SESSION_TTL_DAYS and slide
 * forward on use, writing at most once an hour.
 */

export const SESSION_RENEW_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 200;
/** Most expired rows one sign-in deletes, so a large backlog never slows a single request down. */
export const SESSION_PRUNE_BATCH = 500;

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  githubLogin: string | null;
}

export interface ActiveSession {
  /** SHA-256 of the cookie token (the row id). */
  id: string;
  userId: string;
  activeOrgId: string | null;
  /** Orgs this session signed in to through the org's SSO connection (R4.6). */
  ssoOrgIds: string[];
  expiresAt: Date;
  user: SessionUser;
  /** Whether this lookup extended the session (lastSeenAt/expiresAt were written). */
  renewed: boolean;
}

export interface SessionClock {
  now: Date;
  ttlDays: number;
}

/**
 * Deletes up to `limit` expired sessions of any user (using the index on `expires_at`), so rows of users who never
 * come back, with their IP and user agent, do not stay forever. Runs on every sign-in.
 */
export async function pruneExpiredSessions(db: Db, now: Date, limit: number = SESSION_PRUNE_BATCH): Promise<void> {
  const expired = db.select({ id: sessions.id }).from(sessions).where(lt(sessions.expiresAt, now)).limit(limit);
  await db.delete(sessions).where(inArray(sessions.id, expired));
}

/** Issues a new session and returns the raw token for the cookie. Prunes expired sessions first. */
export async function createSession(
  db: Db,
  input: { userId: string; activeOrgId: string | null; ip?: string | null; userAgent?: string | null; ssoOrgIds?: string[] } & SessionClock,
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken(32);
  const id = hashToken(token);
  const expiresAt = new Date(input.now.getTime() + input.ttlDays * DAY_MS);
  await pruneExpiredSessions(db, input.now);
  await db.insert(sessions).values({
    id,
    userId: input.userId,
    activeOrgId: input.activeOrgId,
    createdAt: input.now,
    lastSeenAt: input.now,
    expiresAt,
    ip: input.ip?.slice(0, 64) ?? null,
    userAgent: input.userAgent?.slice(0, 512) ?? null,
    ssoOrgIds: input.ssoOrgIds ?? [],
  });
  return { token, id, expiresAt };
}

/**
 * Resolves a cookie token to its session and user. Unknown tokens return null; expired sessions are deleted and
 * return null. A session last seen over an hour ago is renewed to `now + ttl`.
 */
export async function validateSessionToken(db: Db, token: string | undefined | null, clock: SessionClock): Promise<ActiveSession | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const id = hashToken(token);
  const [row] = await db
    .select({
      session: sessions,
      user: { id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, githubLogin: users.githubLogin },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id));
  if (!row) return null;
  const now = clock.now.getTime();
  if (row.session.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  let expiresAt = row.session.expiresAt;
  let renewed = false;
  if (now - row.session.lastSeenAt.getTime() >= SESSION_RENEW_INTERVAL_MS) {
    expiresAt = new Date(now + clock.ttlDays * DAY_MS);
    await db.update(sessions).set({ lastSeenAt: clock.now, expiresAt }).where(eq(sessions.id, id));
    renewed = true;
  }
  return { id, userId: row.session.userId, activeOrgId: row.session.activeOrgId, ssoOrgIds: row.session.ssoOrgIds, expiresAt, user: row.user, renewed };
}

/** The session carried by a request's cookie, for route handlers. */
export function sessionFromRequest(db: Db, req: Request, clock: SessionClock): Promise<ActiveSession | null> {
  return validateSessionToken(db, readCookie(req, SESSION_COOKIE), clock);
}

export async function deleteSessionByToken(db: Db, token: string | undefined | null): Promise<void> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return;
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Switches a session's active org after verifying the user is a member. Returns false (and changes nothing) otherwise. */
export async function setActiveOrg(db: Db, input: { sessionId: string; userId: string; orgId: string }): Promise<boolean> {
  const membership = await getMembership(db, input.orgId, input.userId);
  if (!membership) return false;
  const rows = await db
    .update(sessions)
    .set({ activeOrgId: input.orgId })
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Client address and agent recorded on a session (first `X-Forwarded-For` hop when behind a proxy). */
export function requestMetadata(req: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || req.headers.get("x-real-ip") || null, userAgent: req.headers.get("user-agent") };
}
