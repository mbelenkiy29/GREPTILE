/**
 * Cookie names, attributes, and (de)serialization for built-in auth (R6.1). Kept free of database and Next.js
 * imports so `proxy.ts` and the route-handler factories can use it.
 */

/** Session cookie: a random token; the database stores only its SHA-256. */
export const SESSION_COOKIE = "or_session";
/** Marks a session cookie as refreshed within the last hour, so `proxy.ts` re-issues it at most hourly. */
export const SESSION_REFRESH_COOKIE = "or_session_fresh";
/** Signed OAuth state + PKCE verifier + `next`, scoped to the GitHub sign-in routes, valid 10 minutes. */
export const OAUTH_COOKIE = "or_oauth";
export const OAUTH_COOKIE_PATH = "/api/auth/github";
export const OAUTH_MAX_AGE_S = 10 * 60;
export const SESSION_REFRESH_S = 60 * 60;

/** Request header `proxy.ts` sets to the path being visited, so server components can build `?next=`. */
export const PATH_HEADER = "x-openreview-path";

export interface CookieConfig {
  appUrl: string;
  nodeEnv: string;
  sessionTtlDays: number;
}

export interface CookieOptions {
  maxAge: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict";
}

/** `Secure` whenever the app is served over https, and always in production. */
export function secureCookies(config: Pick<CookieConfig, "appUrl" | "nodeEnv">): boolean {
  return config.nodeEnv === "production" || new URL(config.appUrl).protocol === "https:";
}

export function sessionCookieOptions(config: CookieConfig): Required<CookieOptions> {
  return {
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
    path: "/",
    httpOnly: true,
    secure: secureCookies(config),
    sameSite: "lax",
  };
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`];
  if (opts.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite === "strict" ? "Strict" : "Lax"}`);
  return parts.join("; ");
}

/** Set-Cookie values that delete the session cookies. */
export function clearSessionCookies(config: CookieConfig): string[] {
  const opts = { ...sessionCookieOptions(config), maxAge: 0 };
  return [serializeCookie(SESSION_COOKIE, "", opts), serializeCookie(SESSION_REFRESH_COOKIE, "", opts)];
}

/** Set-Cookie values for a newly issued session token. */
export function issueSessionCookies(config: CookieConfig, token: string): string[] {
  const opts = sessionCookieOptions(config);
  return [
    serializeCookie(SESSION_COOKIE, token, opts),
    serializeCookie(SESSION_REFRESH_COOKIE, "1", { ...opts, maxAge: SESSION_REFRESH_S }),
  ];
}

/** Reads one cookie from a request's `Cookie` header. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
