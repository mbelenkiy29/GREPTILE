import { NextResponse, type NextRequest } from "next/server";
import {
  PATH_HEADER,
  SESSION_COOKIE,
  SESSION_REFRESH_COOKIE,
  SESSION_REFRESH_S,
  sessionCookieOptions,
  type CookieConfig,
} from "./cookies";
import { signInPath } from "./redirect";

/**
 * The cheap, database-free gate `proxy.ts` runs in front of signed-in areas (R6.1):
 *
 * - no session cookie → redirect to `/sign-in?next=<path>`;
 * - otherwise pass the visited path upstream in PATH_HEADER (server components use it for `?next=`), and at most
 *   once an hour re-issue the session cookie with a fresh Max-Age so an active session's cookie slides along with
 *   its database expiry.
 *
 * Real validation (token hash lookup, expiry, membership, role) always happens server-side.
 */
export function authGate(req: NextRequest, config: CookieConfig): NextResponse {
  const path = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.redirect(new URL(signInPath(path), `${config.appUrl}/`));

  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, path);
  const res = NextResponse.next({ request: { headers } });
  if (!req.cookies.has(SESSION_REFRESH_COOKIE)) {
    const opts = sessionCookieOptions(config);
    res.cookies.set(SESSION_COOKIE, token, opts);
    res.cookies.set(SESSION_REFRESH_COOKIE, "1", { ...opts, maxAge: SESSION_REFRESH_S });
  }
  return res;
}
