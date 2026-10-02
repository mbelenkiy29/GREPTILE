/** Small response helpers shared by the auth route handlers. */

export function redirectTo(location: string, cookies: string[] = [], status: 302 | 303 = 302): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

export function plainError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/** Path plus query of a request URL (what `?next=` should bring the user back to). */
export function pathWithQuery(req: Request): string {
  const url = new URL(req.url);
  return `${url.pathname}${url.search}`;
}
