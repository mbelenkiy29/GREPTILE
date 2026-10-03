import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createAppJwt, normalizePem } from "@/lib/github/app";
import { RECOMMENDED_PERMISSIONS, REQUIRED_PERMISSIONS } from "@/lib/data/installations";
import { users } from "@/lib/db/schema";
import { setupEnv } from "@/lib/env";
import {
  buildManifest,
  completeManifestSetup,
  defaultAppName,
  envLines,
  isGitHubAppConfigured,
  isSetupField,
  manifestFormAction,
  setupAccess,
  setupFormSchema,
  signSetupState,
  verifySetupState,
} from "@/lib/setup/github-app";
import { GITHUB_WEBHOOK_EVENTS } from "@/lib/webhooks/github";
import { makeUser } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { fakeFetch, jsonResponse } from "./helpers/fake-fetch";

const ROOT = path.resolve(__dirname, "..");
const SECRET = "setup-test-secret-0123456789";
const APP_URL = "https://review.example.com";
/** Events GitHub delivers to every App without a subscription (they cannot be listed in a manifest). */
const ALWAYS_DELIVERED = ["installation", "installation_repositories"];

/** A real RSA key built at runtime (no key material is committed). */
function testPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function conversion(pem: string, over: Record<string, unknown> = {}) {
  return {
    id: 4242,
    slug: "openreview-review-example-com",
    name: "OpenReview review.example.com",
    html_url: "https://github.com/apps/openreview-review-example-com",
    owner: { login: "acme", type: "Organization" },
    client_id: "Iv23liTestClient",
    client_secret: ["client", "secret", "fixture"].join("-"),
    webhook_secret: ["hook", "secret", "fixture"].join("-"),
    pem,
    ...over,
  };
}

describe("GitHub App manifest and setup (R6.25)", () => {
  test("R6.25 the manifest requests exactly the permissions and events the code needs, with this server's URLs", () => {
    const m = buildManifest(`${APP_URL}/`, { name: "OpenReview Acme", public: true });
    expect(m.name).toBe("OpenReview Acme");
    expect(m.public).toBe(true);
    expect(m.url).toBe(APP_URL);
    expect(m.hook_attributes).toEqual({ url: `${APP_URL}/api/webhooks/github`, active: true });
    expect(m.redirect_url).toBe(`${APP_URL}/setup/github-app/callback`);
    expect(m.callback_urls).toEqual([`${APP_URL}/api/auth/github/callback`]);
    expect(m.setup_url).toBe(`${APP_URL}/api/github/callback`);
    expect(m.request_oauth_on_install).toBe(false);
    expect(JSON.stringify(m)).not.toContain("{{");
    // Permissions: the required ones plus the recommended ones, nothing more.
    expect(m.default_permissions).toEqual({ ...REQUIRED_PERMISSIONS, ...RECOMMENDED_PERMISSIONS });
    // Events: everything the webhook router handles, minus ping and what GitHub always delivers.
    expect([...m.default_events].sort()).toEqual(GITHUB_WEBHOOK_EVENTS.filter((e) => e !== "ping" && !ALWAYS_DELIVERED.includes(e)).sort());
    // The router's switch handles exactly the listed events.
    const source = readFileSync(path.join(ROOT, "lib/webhooks/github.ts"), "utf8");
    const body = source.slice(source.indexOf("export async function routeGitHubEvent"), source.indexOf("export async function processDelivery"));
    const cases = [...body.matchAll(/case "([a-z_]+)":/g)].map((c) => c[1]);
    expect(cases.sort()).toEqual([...GITHUB_WEBHOOK_EVENTS].sort());
    // The template defaults to a private App.
    expect(buildManifest(APP_URL).public).toBe(false);
    expect(defaultAppName("https://a-very-long-hostname-for-openreview.example.com").length).toBeLessThanOrEqual(34);
  });

  test("R6.25 the manifest is posted to the account's or organization's new-App page with a browser-bound state", () => {
    const state = signSetupState(SECRET, "nonce-1", 1_000_000);
    expect(manifestFormAction("https://github.com", "", state)).toBe(`https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`);
    expect(manifestFormAction("https://ghe.example.com/", "acme", state)).toBe(`https://ghe.example.com/organizations/acme/settings/apps/new?state=${encodeURIComponent(state)}`);
    expect(verifySetupState(SECRET, state, "nonce-1", 1_000_000 + 5_000)).toBe(true);
    expect(verifySetupState(SECRET, state, "nonce-2", 1_000_000 + 5_000)).toBe(false);
    expect(verifySetupState(SECRET, state, undefined, 1_000_000 + 5_000)).toBe(false);
    expect(verifySetupState("another-secret-0123456789", state, "nonce-1", 1_000_000 + 5_000)).toBe(false);
    expect(verifySetupState(SECRET, state, "nonce-1", 1_000_000 + 61 * 60_000)).toBe(false);
    expect(verifySetupState(SECRET, `${state}x`, "nonce-1", 1_000_000 + 5_000)).toBe(false);
    expect(state).not.toContain("nonce-1");
    // Form validation: GitHub organization logins and App name length.
    expect(setupFormSchema.safeParse({ owner: "acme-inc", name: "OpenReview" }).success).toBe(true);
    expect(setupFormSchema.safeParse({ owner: "../evil", name: "OpenReview" }).success).toBe(false);
    expect(setupFormSchema.safeParse({ owner: "", name: "x".repeat(35) }).success).toBe(false);
    // Form errors are shown from a fixed list by field name, never as text taken from the URL.
    expect(isSetupField("owner") && isSetupField("name")).toBe(true);
    for (const v of ["__proto__", "toString", "<script>", undefined]) expect(isSetupField(v)).toBe(false);
  });

  test("R6.25 the setup callback exchanges the one-time code and returns the App credentials for .env without storing them", async () => {
    const pem = testPem();
    const http = fakeFetch(() => jsonResponse(conversion(pem), 201));
    const now = 5_000_000;
    const state = signSetupState(SECRET, "browser-nonce", now - 60_000);
    const deps = { fetch: http.fetch, appSecret: SECRET, githubApiUrl: "https://api.github.com/", githubWebUrl: "https://github.com", now: () => now };
    const result = await completeManifestSetup(deps, { code: "abc123_-XYZ", state, nonce: "browser-nonce" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({ url: "https://api.github.com/app-manifests/abc123_-XYZ/conversions", method: "POST" });
    expect(http.requests[0]!.headers.authorization).toBeUndefined();
    expect(result.app).toMatchObject({
      id: 4242,
      slug: "openreview-review-example-com",
      owner: "acme",
      clientId: "Iv23liTestClient",
      settingsUrl: "https://github.com/organizations/acme/settings/apps/openreview-review-example-com",
      webhookSecret: "hook-secret-fixture",
    });

    // The .env block parses back (as Next.js reads .env) into a key that signs App JWTs.
    const lines = envLines(result.app, result.app.webhookSecret!);
    expect(lines.split("\n")).toHaveLength(6);
    const dir = mkdtempSync(path.join(tmpdir(), "or-env-"));
    try {
      writeFileSync(path.join(dir, ".env"), `${lines}\n`);
      const nextEnv = createRequire(createRequire(import.meta.url).resolve("next/package.json"))("@next/env") as {
        loadEnvConfig(dir: string, dev?: boolean, log?: { info(): void; error(): void }, forceReload?: boolean): { parsedEnv?: Record<string, string> };
      };
      const loaded = nextEnv.loadEnvConfig(dir, false, { info: () => undefined, error: () => undefined }, true).parsedEnv ?? {};
      expect(loaded).toMatchObject({ GITHUB_APP_ID: "4242", GITHUB_APP_SLUG: "openreview-review-example-com", GITHUB_WEBHOOK_SECRET: "hook-secret-fixture" });
      expect(normalizePem(loaded.GITHUB_APP_PRIVATE_KEY!)).toBe(pem.trim());
      expect(createAppJwt("4242", normalizePem(loaded.GITHUB_APP_PRIVATE_KEY!)).split(".")).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // A personal-account App links to the user's settings; a missing webhook secret is reported as null.
    const personal = await completeManifestSetup(
      { ...deps, fetch: fakeFetch(() => jsonResponse(conversion(pem, { owner: { login: "dana", type: "User" }, webhook_secret: null }), 201)).fetch },
      { code: "c2", state, nonce: "browser-nonce" },
    );
    expect(personal.ok && personal.app).toMatchObject({ settingsUrl: "https://github.com/settings/apps/openreview-review-example-com", webhookSecret: null });
  });

  test("R6.25 the setup callback refuses foreign or expired flows and reports used codes", async () => {
    const http = fakeFetch(() => jsonResponse({ message: "Not Found" }, 404));
    const deps = { fetch: http.fetch, appSecret: SECRET, githubApiUrl: "https://api.github.com", githubWebUrl: "https://github.com", now: () => 10_000_000 };
    const state = signSetupState(SECRET, "mine", 10_000_000);
    // Started in another browser (no or another nonce): GitHub is never called.
    expect(await completeManifestSetup(deps, { code: "abc", state, nonce: undefined })).toMatchObject({ ok: false, error: "invalid_state" });
    expect(await completeManifestSetup(deps, { code: "abc", state, nonce: "theirs" })).toMatchObject({ ok: false, error: "invalid_state" });
    // Codes are opaque tokens; anything that could change the URL path is refused.
    expect(await completeManifestSetup(deps, { code: "../../user", state, nonce: "mine" })).toMatchObject({ ok: false, error: "invalid_request" });
    expect(await completeManifestSetup(deps, { code: undefined, state, nonce: "mine" })).toMatchObject({ ok: false, error: "invalid_request" });
    expect(http.requests).toHaveLength(0);
    // A code GitHub no longer accepts (used or expired).
    expect(await completeManifestSetup(deps, { code: "abc", state, nonce: "mine" })).toMatchObject({ ok: false, error: "expired_code" });
    const broken = { ...deps, fetch: fakeFetch(() => jsonResponse({ id: 1 }, 201)).fetch };
    expect(await completeManifestSetup(broken, { code: "abc", state, nonce: "mine" })).toMatchObject({ ok: false, error: "github_error" });
  });

  test("R6.25 the setup page is open only on a fresh install, then to instance admins", async () => {
    const db = await createTestDb();
    const unconfigured = setupEnv({ APP_URL, APP_SECRET: SECRET });
    expect(isGitHubAppConfigured(unconfigured)).toBe(false);
    // Fresh install: nobody has signed in and no App is configured.
    expect(await setupAccess(db, unconfigured, null)).toEqual({ allowed: true, reason: "fresh_install" });

    const first = await makeUser(db, "first", "First@Example.com");
    await new Promise((r) => setTimeout(r, 5));
    const second = await makeUser(db, "second", "second@example.com");
    expect(await setupAccess(db, unconfigured, null)).toEqual({ allowed: false, reason: "sign_in" });
    expect(await setupAccess(db, unconfigured, first)).toEqual({ allowed: true, reason: "instance_admin" });
    expect(await setupAccess(db, unconfigured, second)).toEqual({ allowed: false, reason: "not_admin" });

    const configured = setupEnv({
      APP_URL,
      APP_SECRET: SECRET,
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "openreview",
      GITHUB_APP_PRIVATE_KEY: "pem",
      GITHUB_WEBHOOK_SECRET: "hook",
      INSTANCE_ADMIN_EMAILS: " ops@example.com , SECOND@example.com",
    });
    expect(isGitHubAppConfigured(configured)).toBe(true);
    // INSTANCE_ADMIN_EMAILS replaces the first-user rule (case-insensitive).
    expect(await setupAccess(db, configured, second)).toEqual({ allowed: true, reason: "instance_admin" });
    expect(await setupAccess(db, configured, first)).toEqual({ allowed: false, reason: "not_admin" });
    expect(await setupAccess(db, configured, { id: "usr_x", email: null })).toEqual({ allowed: false, reason: "not_admin" });
    // A configured instance is never open, even with no users.
    await db.delete(users);
    expect(await setupAccess(db, configured, null)).toEqual({ allowed: false, reason: "sign_in" });
    // setupEnv works without the GitHub App variables and without APP_SECRET.
    expect(setupEnv({}).APP_SECRET).toBeUndefined();
    expect(setupEnv({ APP_SECRET: "short" }).APP_SECRET).toBeUndefined();
  });
});
