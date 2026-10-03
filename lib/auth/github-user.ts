import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { authAccounts } from "@/lib/db/schema";
import { errorMessage, log } from "@/lib/log";
import { outboundFetch } from "@/lib/net/fetch";

/**
 * GitHub user-to-server helpers (R6.1, R1.1): the OAuth code exchange, the signed-in user's profile, and the
 * installations of this GitHub App the user can access. The user access token is passed in by the caller and is
 * never logged or included in error messages.
 */

export interface GitHubUserDeps {
  fetch?: typeof fetch;
  /** REST API base, e.g. https://api.github.com or https://ghe.example.com/api/v3. */
  apiUrl?: string;
}

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;

/** GitHub rejected the user token (revoked or expired): the user must sign in with GitHub again. */
export class GitHubUserTokenError extends Error {}

/** Sign-in failure with a stable code for `/sign-in?error=<code>`. */
export class GitHubSignInError extends Error {
  constructor(
    readonly code: "exchange_failed" | "github_unavailable",
    message: string,
  ) {
    super(message);
  }
}

function apiBase(deps: GitHubUserDeps) {
  return (deps.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
}

async function userGet(token: string, url: string, deps: GitHubUserDeps): Promise<Response> {
  const res = await (deps.fetch ?? outboundFetch)(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "openreview",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new GitHubUserTokenError("GitHub rejected the user token");
  return res;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export interface UserToken {
  accessToken: string;
  /** null when the GitHub App does not expire user tokens. */
  expiresAt: Date | null;
}

/** Exchanges an authorization code (+ PKCE verifier) for a user access token. */
export async function exchangeOAuthCode(
  input: { code: string; codeVerifier: string; redirectUri: string; clientId: string; clientSecret: string; now: Date },
  deps: { fetch?: typeof fetch; webUrl: string },
): Promise<UserToken> {
  let res: Response;
  try {
    res = await (deps.fetch ?? outboundFetch)(`${deps.webUrl.replace(/\/$/, "")}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "openreview" },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubSignInError("github_unavailable", `GitHub token endpoint unreachable: ${errorMessage(err)}`);
  }
  if (res.status >= 500) throw new GitHubSignInError("github_unavailable", `GitHub token endpoint returned ${res.status}`);
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !parsed.success || !parsed.data.access_token) {
    const reason = parsed.success ? (parsed.data.error ?? `status ${res.status}`) : "malformed response";
    throw new GitHubSignInError("exchange_failed", `GitHub refused the authorization code: ${reason}`);
  }
  const { access_token, expires_in } = parsed.data;
  return { accessToken: access_token, expiresAt: expires_in ? new Date(input.now.getTime() + expires_in * 1000) : null };
}

const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
  name: z.string().max(255).nullish(),
  avatar_url: z.string().url().nullish(),
});

const emailsSchema = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

export interface GitHubProfile {
  id: number;
  login: string;
  name: string;
  avatarUrl: string | null;
  /** Primary verified email, lowercased; null when the App lacks the email permission or none is verified. */
  email: string | null;
}

/** Fetches `/user` and the primary verified address from `/user/emails`. */
export async function fetchGitHubProfile(token: string, deps: GitHubUserDeps): Promise<GitHubProfile> {
  const base = apiBase(deps);
  let userRes: Response;
  try {
    userRes = await userGet(token, `${base}/user`, deps);
  } catch (err) {
    if (err instanceof GitHubUserTokenError) throw new GitHubSignInError("exchange_failed", "GitHub rejected the new token");
    throw new GitHubSignInError("github_unavailable", `GitHub /user failed: ${errorMessage(err)}`);
  }
  if (!userRes.ok) throw new GitHubSignInError("github_unavailable", `GitHub /user returned ${userRes.status}`);
  const user = userSchema.safeParse(await userRes.json().catch(() => null));
  if (!user.success) throw new GitHubSignInError("github_unavailable", "GitHub /user returned an unexpected payload");

  let email: string | null = null;
  try {
    const res = await userGet(token, `${base}/user/emails?per_page=100`, deps);
    if (res.ok) {
      const emails = emailsSchema.safeParse(await res.json().catch(() => null));
      const primary = emails.success ? emails.data.find((e) => e.primary && e.verified) : undefined;
      email = primary ? primary.email.trim().toLowerCase() : null;
    } else {
      log.warn("GitHub /user/emails unavailable; continuing without an email", { status: res.status, githubLogin: user.data.login });
    }
  } catch (err) {
    log.warn("GitHub /user/emails failed; continuing without an email", { error: errorMessage(err), githubLogin: user.data.login });
  }

  return {
    id: user.data.id,
    login: user.data.login,
    name: user.data.name?.trim() || user.data.login,
    avatarUrl: user.data.avatar_url ?? null,
    email,
  };
}

const installationsPageSchema = z.object({
  installations: z.array(z.object({ id: z.number().int(), account: z.object({ login: z.string() }).nullish() })),
});

export interface UserInstallation {
  id: number;
  accountLogin: string | null;
}

/**
 * Installations of this GitHub App that the token's user can access (`GET /user/installations`, paginated).
 * Throws GitHubUserTokenError when GitHub rejects the token.
 */
export async function listUserInstallations(token: string, deps: GitHubUserDeps = {}): Promise<UserInstallation[]> {
  const out: UserInstallation[] = [];
  const base = apiBase(deps);
  const origin = new URL(base).origin;
  let url: string | null = `${base}/user/installations?per_page=100`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await userGet(token, url, deps);
    if (!res.ok) throw new Error(`GitHub /user/installations returned ${res.status}`);
    const parsed = installationsPageSchema.parse(await res.json());
    out.push(...parsed.installations.map((i) => ({ id: i.id, accountLogin: i.account?.login ?? null })));
    const next: string | null = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    // Only follow pagination on the API's own origin; the token must never be sent anywhere else.
    url = next && new URL(next).origin === origin ? next : null;
  }
  return out;
}

/** Whether the token's user can access the given installation of this App. */
export async function userCanAccessInstallation(token: string, installationId: number, deps: GitHubUserDeps = {}): Promise<boolean> {
  const installations = await listUserInstallations(token, deps);
  return installations.some((i) => i.id === installationId);
}

/** Tokens this close to expiry are treated as expired, so a check never runs with a token that lapses mid-flight. */
const EXPIRY_MARGIN_MS = 60_000;

/** The user's stored GitHub user token, decrypted; null when missing, expired, or unreadable. */
export async function getUserGitHubToken(db: Db, userId: string, now: Date = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ enc: authAccounts.accessTokenEnc, expiresAt: authAccounts.accessTokenExpiresAt })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.provider, "github")));
  if (!row?.enc) return null;
  if (row.expiresAt && row.expiresAt.getTime() - EXPIRY_MARGIN_MS <= now.getTime()) return null;
  try {
    return decryptSecret(row.enc);
  } catch (err) {
    log.warn("stored GitHub user token could not be decrypted", { userId, error: errorMessage(err) });
    return null;
  }
}

/** Forgets the user's GitHub token (after GitHub rejected it), so the next check sends them through sign-in. */
export async function clearUserGitHubToken(db: Db, userId: string): Promise<void> {
  await db
    .update(authAccounts)
    .set({ accessTokenEnc: null, accessTokenExpiresAt: null })
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.provider, "github")));
}
