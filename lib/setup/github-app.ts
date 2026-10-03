/**
 * GitHub App setup through GitHub's app-manifest flow (R6.25). An operator opens `/setup/github-app`, which posts the
 * manifest built from `github-app-manifest.json` to GitHub; GitHub creates the App and redirects back with a one-time
 * code, which {@link completeManifestSetup} exchanges (`POST /app-manifests/{code}/conversions`) for the App's id,
 * slug, OAuth client, webhook secret, and private key. Those are shown once for the operator to paste into `.env` and
 * are never stored by OpenReview.
 *
 * Who may use it ({@link setupAccess}): while no GitHub App is configured and nobody has signed in yet, anyone who can
 * reach the server (a fresh install has no other way in); otherwise only instance admins (`INSTANCE_ADMIN_EMAILS`, or
 * the first user when that is empty). The `state` sent to GitHub is bound to a random nonce in an HttpOnly cookie of
 * the browser that started the flow, so nobody can make an operator's browser finish someone else's App creation.
 */
import { createHmac } from "node:crypto";
import { asc } from "drizzle-orm";
import { z } from "zod";
import template from "@/github-app-manifest.json";
import { safeEqual } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import type { SetupEnv } from "@/lib/env";
import { errorMessage } from "@/lib/log";

/** Cookie holding the flow's nonce, scoped to the setup pages. */
export const SETUP_COOKIE = "or_ghapp_setup";
export const SETUP_COOKIE_PATH = "/setup/github-app";
/** How long a started setup may take on GitHub before its state expires. */
export const SETUP_MAX_AGE_S = 60 * 60;
/** GitHub limits App names to 34 characters. */
export const APP_NAME_MAX = 34;

export type GitHubAppManifest = typeof template;

/** Whether every variable the GitHub integration needs is set. */
export function isGitHubAppConfigured(e: Pick<SetupEnv, "GITHUB_APP_ID" | "GITHUB_APP_SLUG" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_WEBHOOK_SECRET">): boolean {
  return Boolean(e.GITHUB_APP_ID && e.GITHUB_APP_SLUG && e.GITHUB_APP_PRIVATE_KEY && e.GITHUB_WEBHOOK_SECRET);
}

/** The manifest for this server: the template with `{{APP_URL}}` replaced, plus the chosen name and visibility. */
export function buildManifest(appUrl: string, opts: { name?: string; public?: boolean } = {}): GitHubAppManifest {
  const origin = appUrl.replace(/\/+$/, "");
  const filled = JSON.parse(JSON.stringify(template).replaceAll("{{APP_URL}}", origin)) as GitHubAppManifest;
  return { ...filled, name: opts.name?.trim() || filled.name, public: opts.public ?? filled.public };
}

/** A default App name that tells several OpenReview servers apart on one GitHub account. */
export function defaultAppName(appUrl: string): string {
  return `OpenReview ${new URL(appUrl).hostname}`.slice(0, APP_NAME_MAX).trim();
}

const ownerSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "Enter a GitHub organization login (letters, digits, and hyphens).");

export const setupFormSchema = z.object({
  owner: z.union([z.literal(""), ownerSchema]).default(""),
  name: z.string().trim().min(1, "Enter a name for the App.").max(APP_NAME_MAX, `GitHub limits App names to ${APP_NAME_MAX} characters.`),
  public: z.boolean().default(false),
});
export type SetupForm = z.infer<typeof setupFormSchema>;

/** Where the browser posts the manifest: the account's or the organization's "new App" page on GitHub. */
export function manifestFormAction(githubWebUrl: string, owner: string, state: string): string {
  const base = githubWebUrl.replace(/\/+$/, "");
  const path = owner ? `/organizations/${encodeURIComponent(owner)}/settings/apps/new` : "/settings/apps/new";
  const url = new URL(`${base}${path}`);
  url.searchParams.set("state", state);
  return url.toString();
}

function mac(secret: string, nonce: string, issuedAt: number): string {
  return createHmac("sha256", secret).update(`github-app-setup:${nonce}:${issuedAt}`).digest("base64url");
}

/** The `state` for GitHub: issue time and a MAC over it and the cookie's nonce (the nonce itself never leaves the cookie). */
export function signSetupState(secret: string, nonce: string, now = Date.now()): string {
  return `${now.toString(36)}.${mac(secret, nonce, now)}`;
}

/** Whether `state` was issued for this browser's `nonce` within {@link SETUP_MAX_AGE_S}. */
export function verifySetupState(secret: string, state: string, nonce: string | undefined, now = Date.now()): boolean {
  if (!nonce) return false;
  const [t, sig] = state.split(".");
  if (!t || !sig || !/^[0-9a-z]+$/.test(t)) return false;
  const issuedAt = parseInt(t, 36);
  if (!Number.isSafeInteger(issuedAt) || now - issuedAt > SETUP_MAX_AGE_S * 1000 || issuedAt > now + 60_000) return false;
  return safeEqual(sig, mac(secret, nonce, issuedAt));
}

export type SetupAccess =
  | { allowed: true; reason: "fresh_install" | "instance_admin" }
  | { allowed: false; reason: "sign_in" | "not_admin" };

/** Instance admins: `INSTANCE_ADMIN_EMAILS` when set, otherwise the first user who signed in. */
export async function isInstanceAdmin(db: Db, user: { id: string; email: string | null }, adminEmails: string | undefined): Promise<boolean> {
  const listed = (adminEmails ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length) return Boolean(user.email && listed.includes(user.email.toLowerCase()));
  const [first] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
  return first?.id === user.id;
}

/**
 * Who may use the setup page: anyone on a fresh install (no GitHub App configured, no users yet), afterwards instance
 * admins only. A signed-out visitor of a non-fresh install is asked to sign in.
 */
export async function setupAccess(
  db: Db,
  e: Pick<SetupEnv, "GITHUB_APP_ID" | "GITHUB_APP_SLUG" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_WEBHOOK_SECRET" | "INSTANCE_ADMIN_EMAILS">,
  user: { id: string; email: string | null } | null,
): Promise<SetupAccess> {
  if (!isGitHubAppConfigured(e)) {
    const [anyone] = await db.select({ id: users.id }).from(users).limit(1);
    if (!anyone) return { allowed: true, reason: "fresh_install" };
  }
  if (!user) return { allowed: false, reason: "sign_in" };
  return (await isInstanceAdmin(db, user, e.INSTANCE_ADMIN_EMAILS)) ? { allowed: true, reason: "instance_admin" } : { allowed: false, reason: "not_admin" };
}

const conversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().optional(),
  html_url: z.string().url().optional(),
  owner: z.object({ login: z.string(), type: z.string().optional() }).nullable().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().nullable().optional(),
  pem: z.string().includes("PRIVATE KEY"),
});

export interface CreatedGitHubApp {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string | null;
  owner: string | null;
  /** The App's settings page on GitHub (webhook, permissions, private keys). */
  settingsUrl: string;
  clientId: string;
  clientSecret: string;
  /** Null when GitHub returned none; the operator then sets one in the App's settings. */
  webhookSecret: string | null;
  privateKey: string;
}

export type SetupResult = { ok: true; app: CreatedGitHubApp } | { ok: false; error: SetupError; message: string };
export type SetupError = "invalid_request" | "invalid_state" | "expired_code" | "github_error";

/** GitHub's one-time codes are short opaque tokens; anything else is refused before it reaches a URL. */
const CODE_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Finishes the manifest flow: checks `state` against this browser's nonce, then exchanges the one-time `code` for the
 * new App's credentials. Nothing is stored; a second exchange of the same code fails at GitHub.
 */
export async function completeManifestSetup(
  deps: { fetch: typeof fetch; appSecret: string; githubApiUrl: string; githubWebUrl: string; now?: () => number },
  input: { code: string | undefined; state: string | undefined; nonce: string | undefined },
): Promise<SetupResult> {
  if (!input.code || !CODE_RE.test(input.code) || !input.state) {
    return { ok: false, error: "invalid_request", message: "GitHub did not send back a setup code. Start the setup again." };
  }
  if (!verifySetupState(deps.appSecret, input.state, input.nonce, (deps.now ?? Date.now)())) {
    return {
      ok: false,
      error: "invalid_state",
      message: "This setup was not started in this browser, or it expired. Start the setup again from this server's setup page.",
    };
  }
  const url = `${deps.githubApiUrl.replace(/\/+$/, "")}/app-manifests/${input.code}/conversions`;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "openreview-setup" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: "github_error", message: `Could not reach GitHub: ${errorMessage(err, 200)}` };
  }
  if (res.status === 404 || res.status === 422) {
    return {
      ok: false,
      error: "expired_code",
      message: "GitHub no longer accepts this setup code (codes work once and expire after an hour). The App may already exist: check your GitHub App settings, or start the setup again.",
    };
  }
  if (!res.ok) return { ok: false, error: "github_error", message: `GitHub answered HTTP ${res.status} while creating the App.` };
  const parsed = conversionSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { ok: false, error: "github_error", message: "GitHub's answer did not include the App's credentials." };
  const d = parsed.data;
  const web = deps.githubWebUrl.replace(/\/+$/, "");
  const settingsUrl =
    d.owner?.type === "Organization"
      ? `${web}/organizations/${encodeURIComponent(d.owner.login)}/settings/apps/${encodeURIComponent(d.slug)}`
      : `${web}/settings/apps/${encodeURIComponent(d.slug)}`;
  return {
    ok: true,
    app: {
      id: d.id,
      slug: d.slug,
      name: d.name ?? d.slug,
      htmlUrl: d.html_url ?? null,
      owner: d.owner?.login ?? null,
      settingsUrl,
      clientId: d.client_id,
      clientSecret: d.client_secret,
      webhookSecret: d.webhook_secret || null,
      privateKey: d.pem,
    },
  };
}

/** A PEM as one double-quoted `.env` value: Docker Compose and Next.js both turn its `\n` escapes into newlines. */
function pemEnvValue(pem: string): string {
  return `"${pem.trim().replace(/\r?\n/g, "\\n")}"`;
}

/** The lines to paste into `.env` for a created App. */
export function envLines(app: CreatedGitHubApp, webhookSecret: string): string {
  return [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_APP_CLIENT_ID=${app.clientId}`,
    `GITHUB_APP_CLIENT_SECRET=${app.clientSecret}`,
    `GITHUB_WEBHOOK_SECRET=${webhookSecret}`,
    `GITHUB_APP_PRIVATE_KEY=${pemEnvValue(app.privateKey)}`,
  ].join("\n");
}
