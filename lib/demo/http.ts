/**
 * HTTP endpoints of the public demo (R3.7): `POST /api/demo/challenge` issues a proof-of-work challenge and
 * `POST /api/demo/reviews` submits a pull request URL with the solved challenge. No account or cookie is involved;
 * cross-site browser submissions are refused by Origin.
 */
import { z } from "zod";
import type { Db } from "@/lib/db";
import type { DemoEnv } from "@/lib/env";
import type { JobQueue } from "@/lib/jobs/types";
import type { Logger } from "@/lib/log";
import { clientAddress, clientKey } from "./limits";
import { issueChallenge } from "./pow";
import { submitDemoReview } from "./submit";

export interface DemoHttpDeps {
  db: Db;
  queue: JobQueue;
  env: DemoEnv;
  secret: string;
  appUrl: string;
  now?: () => Date;
  log?: Logger;
}

const NO_STORE = { "cache-control": "no-store" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** A browser request from another site (Origin set and not ours). Requests without Origin are not browsers' cross-site posts. */
function crossSite(req: Request, appUrl: string): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin !== new URL(appUrl).origin;
}

export async function handleDemoChallenge(req: Request, deps: DemoHttpDeps): Promise<Response> {
  if (!deps.env.DEMO_ENABLED) return json({ error: "disabled", message: "The public demo is turned off on this server." }, 503);
  if (crossSite(req, deps.appUrl)) return json({ error: "forbidden", message: "Cross-site requests are not allowed." }, 403);
  return json(issueChallenge(deps.secret, { difficulty: deps.env.DEMO_POW_DIFFICULTY, ...(deps.now ? { now: deps.now() } : {}) }));
}

const submitSchema = z.strictObject({
  url: z.string().max(300),
  challenge: z.string().max(400),
  solution: z.string().max(16),
});

export async function handleDemoSubmit(req: Request, deps: DemoHttpDeps): Promise<Response> {
  if (crossSite(req, deps.appUrl)) return json({ error: "forbidden", message: "Cross-site requests are not allowed." }, 403);
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 4096) return json({ error: "too_large", message: "Request too large." }, 413);
  let body: z.infer<typeof submitSchema>;
  try {
    const text = await req.text();
    if (text.length > 4096) return json({ error: "too_large", message: "Request too large." }, 413);
    body = submitSchema.parse(JSON.parse(text));
  } catch {
    return json({ error: "invalid_request", message: "Send JSON with url, challenge, and solution." }, 400);
  }
  const result = await submitDemoReview(
    { db: deps.db, queue: deps.queue, env: deps.env, secret: deps.secret, ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}) },
    { ...body, clientKey: clientKey(deps.secret, clientAddress(req.headers)) },
  );
  if (result.ok) return json({ id: result.id, url: `/try/${result.id}` }, 202);
  return json({ error: result.code, message: result.message }, result.status, result.retryAfterSec ? { "retry-after": String(result.retryAfterSec) } : {});
}
