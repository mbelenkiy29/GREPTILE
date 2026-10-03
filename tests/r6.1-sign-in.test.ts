import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { authGate } from "@/lib/auth/proxy";
import { devLoginAllowed } from "@/lib/auth/config";
import { OAUTH_COOKIE, SESSION_COOKIE, SESSION_REFRESH_COOKIE } from "@/lib/auth/cookies";
import {
  createDevLoginHandler,
  createGitHubSignInCallbackHandler,
  createGitHubSignInStartHandler,
  createLogoutHandler,
} from "@/lib/auth/handlers";
import { installMessage, lookupMessage, signInErrorMessage } from "@/lib/auth/messages";
import { openOAuthState, pkceChallenge, sealOAuthState } from "@/lib/auth/oauth";
import { safeNextPath, signInPath } from "@/lib/auth/redirect";
import { authorizeRequest } from "@/lib/auth/request";
import { upsertDevUser } from "@/lib/auth/users";
import { createSession, pruneExpiredSessions, validateSessionToken } from "@/lib/auth/sessions";
import { decryptSecret, hashToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { createOrg, orgErrorCode } from "@/lib/data/orgs";
import { authAccounts, memberships, orgs, sessions, users } from "@/lib/db/schema";
import { parseAuthEnv } from "@/lib/env";
import { setLogSink } from "@/lib/log";
import { isSameOrigin } from "@/lib/security/csrf";
import { fakeGitHub, makeUser, NOW, setCookies, signedInCookie, TEST_SECRET, testAuthConfig as config } from "./helpers/auth";
import { createTestDb } from "./helpers/db";

/** Without a `next` page, a user whose workspace has no GitHub installation yet lands on the onboarding wizard (R6.2). */
const LANDING = "https://review.example.com/onboarding";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  // lib/crypto derives the secrets-at-rest key from APP_SECRET when ENCRYPTION_KEY is unset.
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function deps(gh: ReturnType<typeof fakeGitHub>, now: Date = NOW, overrides: Partial<typeof config> = {}) {
  return () => ({ db, config: { ...config, ...overrides }, fetch: gh.fetch, now: () => now });
}

/** Runs the start handler and returns the authorize URL plus the state cookie. */
async function startSignIn(gh: ReturnType<typeof fakeGitHub>, next = "/dashboard", now: Date = NOW) {
  const res = await createGitHubSignInStartHandler(deps(gh, now))(new Request(`${config.appUrl}/api/auth/github?next=${encodeURIComponent(next)}`));
  const authorize = new URL(res.headers.get("location")!);
  const cookie = setCookies(res).get(OAUTH_COOKIE)!;
  return { res, authorize, cookie };
}

/** Full sign-in round trip; `extraCookie` simulates a browser that already holds a session cookie. */
async function signIn(gh: ReturnType<typeof fakeGitHub>, opts: { next?: string; extraCookie?: string; now?: Date } = {}) {
  const { authorize, cookie } = await startSignIn(gh, opts.next, opts.now);
  const cookieHeader = [`${OAUTH_COOKIE}=${cookie.value}`, opts.extraCookie].filter(Boolean).join("; ");
  return createGitHubSignInCallbackHandler(deps(gh, opts.now))(
    new Request(`${config.appUrl}/api/auth/github/callback?code=code123&state=${authorize.searchParams.get("state")}`, {
      headers: { cookie: cookieHeader, "user-agent": "vitest", "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    }),
  );
}

describe("GitHub sign-in", () => {
  test("R6.1 OAuth start sets a signed short-lived state cookie and redirects to GitHub with a PKCE S256 challenge", async () => {
    const gh = fakeGitHub();
    const { res, authorize, cookie } = await startSignIn(gh, "/dashboard/repos?tab=1");
    expect(res.status).toBe(302);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://github.example/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("Iv1.testclient");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://review.example.com/api/auth/github/callback");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    expect(cookie.attrs.has("httponly")).toBe(true);
    expect(cookie.attrs.has("secure")).toBe(true);
    expect(cookie.attrs.get("samesite")).toBe("Lax");
    expect(cookie.attrs.get("path")).toBe("/api/auth/github");
    expect(cookie.attrs.get("max-age")).toBe("600");

    const saved = openOAuthState(TEST_SECRET, cookie.value, NOW.getTime())!;
    expect(saved.state).toBe(authorize.searchParams.get("state"));
    expect(saved.state.length).toBeGreaterThanOrEqual(43);
    expect(pkceChallenge(saved.verifier)).toBe(authorize.searchParams.get("code_challenge"));
    expect(authorize.toString()).not.toContain(saved.verifier);
    expect(saved.next).toBe("/dashboard/repos?tab=1");
    expect(openOAuthState("another-secret-0000000000", cookie.value, NOW.getTime())).toBeNull();

    // An unsafe `next` is replaced before it is stored.
    expect(openOAuthState(TEST_SECRET, (await startSignIn(gh, "//evil.example/x")).cookie.value, NOW.getTime())!.next).toBe("/dashboard");

    // Not configured: back to the sign-in page with a readable error.
    const unconfigured = await createGitHubSignInStartHandler(deps(gh, NOW, { githubClientId: undefined }))(new Request(`${config.appUrl}/api/auth/github`));
    expect(unconfigured.headers.get("location")).toBe("https://review.example.com/sign-in?error=github_not_configured");
    expect(signInErrorMessage("github_not_configured")).toMatch(/GITHUB_APP_CLIENT_ID/);
    expect(gh.calls).toEqual([]);
  });

  test("R6.1 OAuth callback rejects a missing, mismatched, tampered, or expired state", async () => {
    const gh = fakeGitHub();
    const callback = (query: string, cookie?: string, now = NOW) =>
      createGitHubSignInCallbackHandler(deps(gh, now))(
        new Request(`${config.appUrl}/api/auth/github/callback?${query}`, { headers: cookie ? { cookie } : {} }),
      );
    const { authorize, cookie } = await startSignIn(gh, "/dashboard/team");
    const state = authorize.searchParams.get("state")!;
    const good = `${OAUTH_COOKIE}=${cookie.value}`;

    const [payload, sig] = cookie.value.split(".");
    const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
    forged.n = "/elsewhere";
    const tampered = `${OAUTH_COOKIE}=${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;

    const cases: [string, Response][] = [
      ["missing cookie", await callback(`code=c&state=${state}`)],
      ["missing state", await callback("code=c", good)],
      ["mismatched state", await callback(`code=c&state=${state.slice(0, -2)}xx`, good)],
      ["tampered cookie", await callback(`code=c&state=${state}`, tampered)],
      ["expired cookie", await callback(`code=c&state=${state}`, good, new Date(NOW.getTime() + 11 * 60 * 1000))],
    ];
    for (const [label, res] of cases) {
      expect(res.status, label).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error"), label).toBe("invalid_state");
      expect(setCookies(res).get(OAUTH_COOKIE)?.attrs.get("max-age"), label).toBe("0");
      expect(setCookies(res).has(SESSION_COOKIE), label).toBe(false);
    }
    const denied = await callback(`error=access_denied&state=${state}`, good);
    expect(denied.headers.get("location")).toBe("https://review.example.com/sign-in?next=%2Fdashboard%2Fteam&error=access_denied");
    expect(gh.calls).toEqual([]);
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
  });

  test("R6.1 first GitHub sign-in creates the user, a personal workspace with an owner membership, and a session whose token is stored only as a hash", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const gh = fakeGitHub({ accessToken: "ghu_secretusertoken1234567890abcdefXYZ" });
    let res: Response;
    try {
      res = await signIn(gh, { next: "/dashboard/repos" });
    } finally {
      restore();
    }
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://review.example.com/dashboard/repos");

    // PKCE verifier and client credentials go to the token endpoint, not the browser.
    const exchange = gh.calls.find((c) => c.url.endsWith("/login/oauth/access_token"))!;
    expect(exchange.method).toBe("POST");
    expect(exchange.body).toMatchObject({ client_id: "Iv1.testclient", client_secret: "test-client-secret", code: "code123", redirect_uri: "https://review.example.com/api/auth/github/callback" });
    expect(pkceChallenge(String(exchange.body!.code_verifier))).toMatch(/^[\w-]{43}$/);
    expect(gh.calls.filter((c) => c.url.startsWith(config.githubApiUrl)).every((c) => c.authorization === "Bearer ghu_secretusertoken1234567890abcdefXYZ")).toBe(true);

    const [user] = await db.select().from(users);
    expect(user).toMatchObject({ githubId: 4242, githubLogin: "octo", name: "Octo Cat", email: "octo@example.com", avatarUrl: "https://avatars.github.example/u/4242" });
    expect(user!.id).toMatch(/^usr_/);

    const [account] = await db.select().from(authAccounts);
    expect(account).toMatchObject({ provider: "github", providerAccountId: "4242", userId: user!.id, login: "octo" });
    expect(account!.accessTokenEnc).not.toContain("ghu_");
    expect(decryptSecret(account!.accessTokenEnc!)).toBe("ghu_secretusertoken1234567890abcdefXYZ");
    expect(account!.accessTokenExpiresAt!.getTime()).toBe(NOW.getTime() + 28_800_000);

    const [org] = await db.select().from(orgs);
    expect(org).toMatchObject({ personal: true, createdBy: user!.id, slug: "octo", name: "octo's workspace" });
    expect(org!.id).toMatch(/^org_[\w-]{16}$/);
    expect(await db.select({ orgId: memberships.orgId, userId: memberships.userId, role: memberships.role }).from(memberships)).toEqual([
      { orgId: org!.id, userId: user!.id, role: "owner" },
    ]);

    const session = setCookies(res).get(SESSION_COOKIE)!;
    expect(session.value).toMatch(/^[\w-]{43}$/);
    expect(session.attrs.has("httponly")).toBe(true);
    expect(session.attrs.has("secure")).toBe(true);
    expect(session.attrs.get("samesite")).toBe("Lax");
    expect(session.attrs.get("path")).toBe("/");
    expect(session.attrs.get("max-age")).toBe(String(30 * 24 * 3600));
    expect(setCookies(res).get(OAUTH_COOKIE)?.attrs.get("max-age")).toBe("0");

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: hashToken(session.value), userId: user!.id, activeOrgId: org!.id, ip: "203.0.113.9", userAgent: "vitest" });
    expect(rows[0]!.id).not.toBe(session.value);
    expect(JSON.stringify(rows)).not.toContain(session.value);

    // Neither the GitHub token nor the session token is ever logged.
    expect(lines.some((l) => l.includes("signed in with GitHub"))).toBe(true);
    expect(lines.join("\n")).not.toContain("ghu_secretusertoken");
    expect(lines.join("\n")).not.toContain(session.value);
  });

  test("R6.1 a second sign-in reuses the user, refreshes the profile, and replaces the stored GitHub token", async () => {
    const first = await signIn(fakeGitHub({ accessToken: "ghu_first000000000000000000000000000" }));
    const firstCookie = setCookies(first).get(SESSION_COOKIE)!.value;
    const [before] = await db.select().from(users);

    // Another browser, a renamed GitHub account, a fresh token without expiry.
    const later = new Date(NOW.getTime() + DAY);
    const second = await signIn(fakeGitHub({ accessToken: "ghu_second00000000000000000000000000", login: "octo-renamed", expiresIn: null }), { now: later });
    expect(second.headers.get("location")).toBe(LANDING);
    const all = await db.select().from(users);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: before!.id, githubLogin: "octo-renamed" });
    expect(all[0]!.lastLoginAt).toEqual(later);
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(1);
    expect(decryptSecret(accounts[0]!.accessTokenEnc!)).toBe("ghu_second00000000000000000000000000");
    expect(accounts[0]!.accessTokenExpiresAt).toBeNull();
    expect(await db.select().from(orgs)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(2);

    // Re-authorizing in a browser that is already signed in as the same user keeps that session.
    const third = await signIn(fakeGitHub({ accessToken: "ghu_third000000000000000000000000000" }), { extraCookie: `${SESSION_COOKIE}=${firstCookie}` });
    expect(setCookies(third).has(SESSION_COOKIE)).toBe(false);
    expect(await db.select().from(sessions)).toHaveLength(2);

    // A different GitHub user signing in on that browser replaces the old session.
    const other = await signIn(fakeGitHub({ githubId: 777, login: "hubot", accessToken: "ghu_hubot000000000000000000000000000" }), {
      extraCookie: `${SESSION_COOKIE}=${firstCookie}`,
    });
    expect(setCookies(other).get(SESSION_COOKIE)?.value).toMatch(/^[\w-]{43}$/);
    expect(await validateSessionToken(db, firstCookie, { now: NOW, ttlDays: 30 })).toBeNull();

    // An address GitHub no longer reports (removed or unverified) is cleared, so it stops matching invitations.
    expect((await db.select().from(users).where(eq(users.id, before!.id)))[0]?.email).toBe(before!.email);
    expect(before!.email).not.toBeNull();
    await signIn(fakeGitHub({ emails: { status: 403 } }), { now: later });
    expect((await db.select().from(users).where(eq(users.id, before!.id)))[0]?.email).toBeNull();
  });

  test("R6.1 sign-in only redirects to safe same-origin paths", async () => {
    expect(safeNextPath("/dashboard/repos?x=1#top")).toBe("/dashboard/repos?x=1#top");
    expect(safeNextPath("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
    expect(safeNextPath("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
    for (const bad of [
      "//evil.example",
      "///evil.example",
      "/.//evil.example",
      "/a/..//evil.example",
      "/x/./..//evil.example",
      "/%2e//evil.example",
      "/a/%2e%2e//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "https://evil.example/dashboard",
      "javascript:alert(1)",
      "/ok\nLocation: https://evil.example",
      "/\t/evil.example",
      " /dashboard",
      "dashboard",
      "",
      undefined,
      null,
      42,
      `/${"a".repeat(3000)}`,
    ]) {
      expect(safeNextPath(bad), String(bad)).toBe("/dashboard");
    }
    const res = await signIn(fakeGitHub(), { next: "//evil.example/steal" });
    expect(res.headers.get("location")).toBe(LANDING);
    const res2 = await signIn(fakeGitHub(), { next: "/\\evil.example" });
    expect(res2.headers.get("location")).toBe(LANDING);
    for (const next of ["/.//evil.example", "/a/..//evil.example", "/x/./..//evil.example"]) {
      const dotted = await signIn(fakeGitHub(), { next });
      const location = new URL(dotted.headers.get("location")!);
      expect(location.origin, next).toBe("https://review.example.com");
      expect(location.pathname, next).toBe(new URL(LANDING).pathname);
    }
    expect(signInPath("/.//evil.example")).toBe("/sign-in");
    expect(safeNextPath("/a/../dashboard/team")).toBe("/dashboard/team");
  });

  test("R6.1 sign-in failures redirect to /sign-in with a readable error and create nothing", async () => {
    const refused = await signIn(fakeGitHub({ exchange: { error: "bad_verification_code" } }), { next: "/dashboard/team" });
    expect(refused.headers.get("location")).toBe("https://review.example.com/sign-in?next=%2Fdashboard%2Fteam&error=exchange_failed");
    expect(signInErrorMessage("exchange_failed")).toMatch(/GitHub/);

    const down = await signIn(fakeGitHub({ exchange: { status: 502 } }));
    expect(new URL(down.headers.get("location")!).searchParams.get("error")).toBe("github_unavailable");
    const profileDown = await signIn(fakeGitHub({ userStatus: 500 }));
    expect(new URL(profileDown.headers.get("location")!).searchParams.get("error")).toBe("github_unavailable");
    const offline = await createGitHubSignInCallbackHandler(() => ({
      db,
      config,
      now: () => NOW,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    }))(
      new Request(`${config.appUrl}/api/auth/github/callback?code=c&state=${"s".repeat(43)}`, {
        headers: { cookie: `${OAUTH_COOKIE}=${sealOAuthState(TEST_SECRET, { state: "s".repeat(43), verifier: "v".repeat(43), next: "/dashboard", issuedAt: NOW.getTime() })}` },
      }),
    );
    expect(new URL(offline.headers.get("location")!).searchParams.get("error")).toBe("github_unavailable");
    expect(signInErrorMessage("something-unknown")).toBe("Sign-in failed. Please try again.");
    expect(await db.select().from(users)).toEqual([]);

    // Without the email permission the sign-in still works, just without an address.
    const noEmail = await signIn(fakeGitHub({ emails: { status: 403 } }));
    expect(noEmail.headers.get("location")).toBe(LANDING);
    expect((await db.select().from(users))[0]?.email).toBeNull();
  });

  test("R6.1 error and notice codes from the URL resolve only to known messages", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(signInErrorMessage(code)).toBe("Sign-in failed. Please try again.");
      expect(installMessage(code)).toBeUndefined();
      expect(orgErrorCode(code)).toBeNull();
    }
    expect(signInErrorMessage("access_denied")).toMatch(/cancelled/);
    expect(installMessage("not_accessible")).toMatch(/can't access that installation/);
    expect(installMessage(["ok"])).toBeUndefined();
    expect(orgErrorCode("last_owner")).toBe("last_owner");
    expect(orgErrorCode(["last_owner"])).toBeNull();
    expect(lookupMessage({ known: "Known." }, "known")).toBe("Known.");
  });

  test("R6.1 signing in again never re-adds a personal-workspace membership that was taken away", async () => {
    await signIn(fakeGitHub());
    const [user] = await db.select().from(users);
    const before = await db.select().from(orgs);
    await db.delete(memberships).where(eq(memberships.userId, user!.id));

    const later = new Date(NOW.getTime() + DAY);
    const again = await signIn(fakeGitHub(), { now: later });
    expect(again.status).toBe(302);
    expect(await db.select().from(memberships)).toEqual([]);
    // No second personal workspace either; the session starts without an org, which sends the user to /orgs.
    expect(await db.select().from(orgs)).toEqual(before);
    const token = setCookies(again).get(SESSION_COOKIE)!.value;
    expect((await validateSessionToken(db, token, { now: later, ttlDays: 30 }))?.activeOrgId).toBeNull();
  });
});

describe("sessions", () => {
  test("R6.1 expired and unknown sessions are rejected, and active sessions slide forward at most once per hour", async () => {
    const user = await makeUser(db, "sam");
    const { token } = await createSession(db, { userId: user.id, activeOrgId: null, now: NOW, ttlDays: 30 });
    const clock = (ms: number) => ({ now: new Date(NOW.getTime() + ms), ttlDays: 30 });

    const early = await validateSessionToken(db, token, clock(30 * 60 * 1000));
    expect(early).toMatchObject({ userId: user.id, renewed: false, expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    const [row0] = await db.select().from(sessions);
    expect(row0!.lastSeenAt).toEqual(NOW);

    const renewed = await validateSessionToken(db, token, clock(HOUR + 60_000));
    expect(renewed?.renewed).toBe(true);
    expect(renewed?.expiresAt).toEqual(new Date(NOW.getTime() + HOUR + 60_000 + 30 * DAY));
    const [row1] = await db.select().from(sessions);
    expect(row1!.lastSeenAt).toEqual(new Date(NOW.getTime() + HOUR + 60_000));
    expect((await validateSessionToken(db, token, clock(HOUR + 120_000)))?.renewed).toBe(false);

    expect(await validateSessionToken(db, "not-a-real-token", clock(0))).toBeNull();
    expect(await validateSessionToken(db, undefined, clock(0))).toBeNull();
    expect(await validateSessionToken(db, token, clock(HOUR + 60_000 + 30 * DAY))).toBeNull();
    expect(await db.select().from(sessions)).toEqual([]);

    // Route handlers treat an expired cookie as signed out.
    const stale = await signedInCookie(db, user.id, null, new Date(NOW.getTime() - 31 * DAY));
    const res = await authorizeRequest({ db, clock: clock(0) }, new Request(`${config.appUrl}/api/x`, { headers: { cookie: stale.cookie } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  test("R6.1 signing in deletes expired sessions of every user, in bounded batches", async () => {
    const gone = await makeUser(db, "gone");
    const stays = await makeUser(db, "stays");
    const longAgo = new Date(NOW.getTime() - 40 * DAY);
    const live = await signedInCookie(db, stays.id, null, new Date(NOW.getTime() - DAY));
    await signedInCookie(db, gone.id, null, longAgo);
    await signedInCookie(db, gone.id, null, longAgo);
    expect(await db.select().from(sessions)).toHaveLength(3);

    // Another user signing in removes the abandoned sessions (with their IP and user agent) of users who never return.
    const res = await signIn(fakeGitHub());
    const octo = setCookies(res).get(SESSION_COOKIE)!.value;
    expect((await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id).sort()).toEqual([live.sessionId, hashToken(octo)].sort());

    // Each pass deletes at most `limit` rows.
    for (let i = 0; i < 3; i++) await signedInCookie(db, gone.id, null, longAgo);
    await pruneExpiredSessions(db, NOW, 2);
    expect(await db.select().from(sessions).where(eq(sessions.userId, gone.id))).toHaveLength(1);
    await pruneExpiredSessions(db, NOW);
    expect(await db.select().from(sessions).where(eq(sessions.userId, gone.id))).toEqual([]);
    expect(await validateSessionToken(db, live.token, { now: NOW, ttlDays: 30 })).toMatchObject({ userId: stays.id });
  });

  test("R6.1 logout requires a same-origin request, deletes the session, and clears the cookie", async () => {
    const user = await makeUser(db, "lou");
    const { cookie, sessionId } = await signedInCookie(db, user.id, null);
    const logout = createLogoutHandler(() => ({ db, config }));
    const post = (headers: Record<string, string>) => logout(new Request(`${config.appUrl}/api/auth/logout`, { method: "POST", headers: { cookie, ...headers } }));

    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect(await db.select({ id: sessions.id }).from(sessions)).toEqual([{ id: sessionId }]);

    const res = await post({ origin: "https://review.example.com" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://review.example.com/sign-in");
    const cleared = setCookies(res);
    expect(cleared.get(SESSION_COOKIE)).toMatchObject({ value: "" });
    expect(cleared.get(SESSION_COOKIE)!.attrs.get("max-age")).toBe("0");
    expect(cleared.get(SESSION_REFRESH_COOKIE)!.attrs.get("max-age")).toBe("0");
    expect(await db.select().from(sessions)).toEqual([]);

    // Browsers that omit Origin still identify same-origin requests via Fetch Metadata.
    const req = (h: Record<string, string>) => new Request("https://review.example.com/x", { method: "POST", headers: h });
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }), config.appUrl)).toBe(true);
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site" }), config.appUrl)).toBe(false);
    expect(isSameOrigin(req({ origin: "https://review.example.com:8443" }), config.appUrl)).toBe(false);
  });

  test("R6.1 proxy sends requests without a session cookie to sign-in and slides the cookie at most hourly", () => {
    const anon = authGate(new NextRequest("https://review.example.com/dashboard/repos?x=1"), config);
    expect(anon.status).toBe(307);
    expect(anon.headers.get("location")).toBe("https://review.example.com/sign-in?next=%2Fdashboard%2Frepos%3Fx%3D1");

    const fresh = authGate(new NextRequest("https://review.example.com/dashboard", { headers: { cookie: `${SESSION_COOKIE}=tok123` } }), config);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("x-middleware-request-x-openreview-path")).toBe("/dashboard");
    const refreshed = setCookies(fresh);
    expect(refreshed.get(SESSION_COOKIE)?.value).toBe("tok123");
    expect(refreshed.get(SESSION_COOKIE)?.attrs.get("max-age")).toBe(String(30 * 24 * 3600));
    expect(refreshed.get(SESSION_COOKIE)?.attrs.has("httponly")).toBe(true);
    expect(refreshed.get(SESSION_REFRESH_COOKIE)?.attrs.get("max-age")).toBe("3600");

    const recent = authGate(
      new NextRequest("https://review.example.com/dashboard", { headers: { cookie: `${SESSION_COOKIE}=tok123; ${SESSION_REFRESH_COOKIE}=1` } }),
      config,
    );
    expect(recent.headers.getSetCookie()).toEqual([]);
  });
});

describe("dev login", () => {
  test("R6.1 dev login is refused in production and only signs in the local developer when enabled", async () => {
    expect(() => parseAuthEnv({ APP_SECRET: TEST_SECRET, NODE_ENV: "production", AUTH_DEV_LOGIN: "true" })).toThrow(/AUTH_DEV_LOGIN/);
    expect(parseAuthEnv({ APP_SECRET: TEST_SECRET, NODE_ENV: "development", AUTH_DEV_LOGIN: "true" }).AUTH_DEV_LOGIN).toBe(true);
    expect(parseAuthEnv({ APP_SECRET: TEST_SECRET, NODE_ENV: "production" })).toMatchObject({ AUTH_DEV_LOGIN: false, SESSION_TTL_DAYS: 30 });

    const post = (overrides: Partial<typeof config>, headers: Record<string, string> = { origin: config.appUrl }) =>
      createDevLoginHandler(() => ({ db, config: { ...config, ...overrides }, now: () => NOW }))(
        new Request(`${config.appUrl}/api/auth/dev`, { method: "POST", headers, body: new URLSearchParams({ next: "/dashboard/team" }) }),
      );

    expect((await post({ devLogin: false, nodeEnv: "development" })).status).toBe(404);
    expect((await post({ devLogin: true, nodeEnv: "production" })).status).toBe(404);
    vi.stubEnv("NODE_ENV", "production");
    expect(devLoginAllowed({ devLogin: true, nodeEnv: "development" })).toBe(false);
    expect((await post({ devLogin: true, nodeEnv: "development" })).status).toBe(404);
    vi.stubEnv("NODE_ENV", "test");
    expect(await db.select().from(users)).toEqual([]);

    expect((await post({ devLogin: true, nodeEnv: "development" }, { origin: "https://evil.example" })).status).toBe(403);

    const ok = await post({ devLogin: true, nodeEnv: "development" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("https://review.example.com/dashboard/team");
    const [dev] = await db.select().from(users);
    expect(dev).toMatchObject({ email: "dev@localhost", name: "Local developer" });
    const [org] = await db.select().from(orgs);
    expect(org).toMatchObject({ personal: true, createdBy: dev!.id });
    const token = setCookies(ok).get(SESSION_COOKIE)!.value;
    expect(await validateSessionToken(db, token, { now: NOW, ttlDays: 30 })).toMatchObject({ userId: dev!.id, activeOrgId: org!.id });

    // Signing in again reuses the same local user and workspace.
    await post({ devLogin: true, nodeEnv: "development" });
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(orgs)).toHaveLength(1);
  });

  test("R6.1 dev login lands in an org the local developer already belongs to instead of creating a workspace", async () => {
    // What `pnpm demo` leaves behind (R6.22): the dev user with an owner seat in the demo org, never signed in.
    const dev = await upsertDevUser(db, NOW);
    const demo = await createOrg(db, { name: "Local demo", createdBy: dev.id });
    await db.insert(memberships).values({ orgId: demo.id, userId: dev.id, role: "owner" }).onConflictDoNothing();

    const ok = await createDevLoginHandler(() => ({ db, config: { ...config, devLogin: true, nodeEnv: "development" }, now: () => NOW }))(
      new Request(`${config.appUrl}/api/auth/dev`, { method: "POST", headers: { origin: config.appUrl } }),
    );
    expect(ok.status).toBe(303);
    expect(await db.select().from(orgs).where(eq(orgs.personal, true))).toEqual([]);
    const token = setCookies(ok).get(SESSION_COOKIE)!.value;
    expect(await validateSessionToken(db, token, { now: NOW, ttlDays: 30 })).toMatchObject({ userId: dev.id, activeOrgId: demo.id });
  });
});
