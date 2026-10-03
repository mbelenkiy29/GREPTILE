import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import nextConfig from "@/next.config";
import { MemoryRateLimiter } from "@/lib/api/rate-limit";
import { defineRoute, executeRoute } from "@/lib/api/router";
import { createGitHubSignInCallbackHandler, createGitHubSignInStartHandler } from "@/lib/auth/handlers";
import type { Db } from "@/lib/db";
import { MemoryQueue } from "@/lib/jobs/types";
import { setLogSink } from "@/lib/log";
import { contentSecurityPolicy, securityHeaders } from "@/lib/security/headers";
import { checkRateLimit, clientAddress, withRateLimit } from "@/lib/security/rate-limit";
import { createOidcCallbackHandler, createSamlAcsHandler, createSsoLookupHandler, createSsoStartHandler, type SsoHandlerDeps } from "@/lib/sso/handlers";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { apiDeps } from "./helpers/api";
import { fakeGitHub, NOW, TEST_SECRET, testAuthConfig as config } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const STACK = /\bat \S+ \(|\.ts:\d+:\d+|node_modules|Error: /;

describe("security headers", () => {
  test("R6.20 security headers are set on every page and API route", async () => {
    const rules = await nextConfig.headers!();
    // One rule for every route, plus no-store / no-referrer for the GitHub App setup pages (R6.25).
    expect(rules.map((r) => r.source)).toEqual(["/:path*", "/setup/:path*"]);
    expect(Object.fromEntries(rules[1]!.headers.map((h) => [h.key, h.value]))).toEqual({ "Cache-Control": "no-store, max-age=0", "Referrer-Policy": "no-referrer" });
    const headers = Object.fromEntries(rules[0]!.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    // The same source pattern matches pages and API routes alike (Next.js path-to-regexp semantics).
    const pattern = /^\/.*$/;
    for (const p of ["/", "/dashboard/settings/sso", "/api/v1/reviews", "/api/auth/saml/sso_x/acs", "/api/webhooks/github"]) expect(p).toMatch(pattern);

    const prod = Object.fromEntries(securityHeaders({ development: false }).map((h) => [h.key, h.value]));
    expect(prod["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    const csp = contentSecurityPolicy({ development: false });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*https:/);
    expect(contentSecurityPolicy({ development: true })).toContain("'unsafe-eval'");
    expect(securityHeaders({ development: true }).some((h) => h.key === "Strict-Transport-Security")).toBe(false);
  });
});

describe("rate limits on public endpoints", () => {
  test("R6.20 sign-in and SSO endpoints answer 429 with retry-after once a client exceeds the limit", async () => {
    const limiter = new MemoryRateLimiter();
    const gh = fakeGitHub();
    const start = withRateLimit("auth.github.start", createGitHubSignInStartHandler(() => ({ db, config, fetch: gh.fetch, now: () => NOW })), () => ({ limiter, limit: 3, now: NOW }));
    const req = (ip: string) => new Request(`${config.appUrl}/api/auth/github`, { headers: { "x-forwarded-for": `198.51.100.1, ${ip}` } });
    for (let i = 0; i < 3; i++) expect((await start(req("203.0.113.5"))).status).toBe(302);
    const limited = await start(req("203.0.113.5"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another client (by the proxy-appended hop, not the spoofable first one) is unaffected.
    expect((await start(req("203.0.113.6"))).status).toBe(302);
    expect(clientAddress(req("203.0.113.7"))).toBe("203.0.113.7");

    const callback = withRateLimit("auth.github.callback", createGitHubSignInCallbackHandler(() => ({ db, config, fetch: gh.fetch, now: () => NOW })), () => ({ limiter, limit: 1, now: NOW }));
    await callback(req("203.0.113.8"));
    expect((await callback(req("203.0.113.8"))).status).toBe(429);

    const ssoDeps = (): SsoHandlerDeps => ({ db, config, net: { allowPrivate: false }, now: () => NOW, rateLimit: { limiter, perMinute: 1 } });
    const ctx = { params: Promise.resolve({ id: "sso_doesnotexist00" }) };
    const ssoReq = (path: string, init: RequestInit = {}) => new Request(`${config.appUrl}${path}`, { ...init, headers: { "x-real-ip": "192.0.2.44", origin: config.appUrl } });
    const handlers: [string, () => Promise<Response>][] = [
      ["lookup", () => createSsoLookupHandler(ssoDeps)(ssoReq("/api/auth/sso", { method: "POST", body: new FormData() }))],
      ["start", () => createSsoStartHandler(ssoDeps)(ssoReq("/api/auth/sso/sso_doesnotexist00/start"), ctx)],
      ["callback", () => createOidcCallbackHandler(ssoDeps)(ssoReq("/api/auth/sso/sso_doesnotexist00/callback"), ctx)],
      ["acs", () => createSamlAcsHandler(ssoDeps)(ssoReq("/api/auth/saml/sso_doesnotexist00/acs", { method: "POST", body: new FormData() }), ctx)],
    ];
    for (const [name, call] of handlers) {
      expect((await call()).status, name).not.toBe(429);
      const res = await call();
      expect(res.status, name).toBe(429);
      expect(res.headers.get("retry-after"), name).toBeTruthy();
    }

    // Invitation acceptance (server actions) uses the same limiter, keyed by user.
    expect(await checkRateLimit("invite.accept", "usr_1", { limiter, limit: 1, now: NOW })).toBeNull();
    expect((await checkRateLimit("invite.accept", "usr_1", { limiter, limit: 1, now: NOW }))?.status).toBe(429);
    expect(await checkRateLimit("invite.accept", "usr_2", { limiter, limit: 1, now: NOW })).toBeNull();
  });

  test("R6.20 the webhook receiver rate limits per installation, counting only signed deliveries", async () => {
    const limiter = new MemoryRateLimiter();
    const handler = createGitHubWebhookHandler(() => ({
      db,
      queue: new MemoryQueue(),
      host: new FakeGitHost(),
      secret: "whsec_test",
      botMention: "openreview",
      now: () => NOW,
      rateLimit: { limiter, perMinute: 2 },
    }));
    let n = 0;
    const deliver = (installation: number, secret = "whsec_test") => {
      const body = JSON.stringify({ zen: "hi", installation: { id: installation } });
      return handler(
        new Request("http://localhost/api/webhooks/github", {
          method: "POST",
          body,
          headers: { "x-github-event": "ping", "x-github-delivery": `d-${++n}`, "x-hub-signature-256": signGitHubPayload(secret, body) },
        }),
      );
    };
    for (let i = 0; i < 5; i++) expect((await deliver(1, "forged")).status).toBe(401);
    expect((await deliver(1)).status).toBeLessThan(300);
    expect((await deliver(1)).status).toBeLessThan(300);
    const limited = await deliver(1);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await deliver(2)).status).toBeLessThan(300);
  });
});

describe("error responses", () => {
  test("R6.20 error responses contain no stack traces or internal messages", async () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      const boom = defineRoute({
        method: "GET",
        path: "/boom",
        summary: "fails",
        tag: "test",
        scope: null,
        public: true,
        responses: { 200: { description: "never" } },
        async handler() {
          throw new Error("connect ECONNREFUSED 10.0.0.7:5432 at Pool.connect (/app/node_modules/pg/lib/pool.js:45:11)");
        },
      });
      const res = await executeRoute(boom, apiDeps(db), new Request("https://review.example.com/api/v1/boom"));
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toMatch(STACK);
      expect(body).not.toContain("ECONNREFUSED");
      expect(JSON.parse(body)).toMatchObject({ error: { code: "internal_error" } });

      // A failing sign-in redirects with a code only.
      const broken = { ...db, transaction: () => Promise.reject(new Error("db down at Object.<anonymous> (/app/x.ts:1:1)")) } as unknown as Db;
      const gh = fakeGitHub();
      const start = await createGitHubSignInStartHandler(() => ({ db, config, fetch: gh.fetch, now: () => NOW }))(new Request(`${config.appUrl}/api/auth/github`));
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const cookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
      const cb = await createGitHubSignInCallbackHandler(() => ({ db: broken, config, fetch: gh.fetch, now: () => NOW }))(
        new Request(`${config.appUrl}/api/auth/github/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie } }),
      );
      expect(cb.status).toBe(302);
      expect(cb.headers.get("location")).not.toMatch(STACK);
      expect(await cb.text()).toBe("");

      // The webhook receiver answers a failure with a status only.
      const failing = createGitHubWebhookHandler(() => ({ db: broken, queue: new MemoryQueue(), host: new FakeGitHost(), secret: "s", botMention: "openreview" }));
      const body2 = JSON.stringify({ zen: "x" });
      const wh = await failing(
        new Request("http://localhost/api/webhooks/github", {
          method: "POST",
          body: body2,
          headers: { "x-github-event": "ping", "x-github-delivery": "d-err", "x-hub-signature-256": signGitHubPayload("s", body2) },
        }),
      );
      expect(await wh.text()).not.toMatch(STACK);
    } finally {
      restore();
    }
    // The details went to the server log instead, with credentials redacted.
    expect(lines.join("\n")).toContain("API request failed");
  });
});
