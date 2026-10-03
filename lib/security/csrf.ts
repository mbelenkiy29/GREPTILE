import { authEnv } from "@/lib/env";

/**
 * CSRF protection for cookie-authenticated, state-changing route handlers (R6.1, R6.20). A request is same-origin
 * when its `Origin` header equals the app's origin, or, when a browser omits `Origin`, when `Sec-Fetch-Site` says
 * `same-origin`. Requests with neither header are refused. Server actions get the equivalent check from Next.js.
 */

export class CsrfError extends Error {
  readonly status = 403;
}

export function isSameOrigin(req: Request, appUrl: string): boolean {
  const expected = new URL(appUrl).origin;
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === expected;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/** Throws `CsrfError` unless the request comes from the app's own origin. */
export function assertSameOrigin(req: Request, appUrl: string = authEnv().APP_URL): void {
  if (!isSameOrigin(req, appUrl)) throw new CsrfError("Cross-origin request refused.");
}
