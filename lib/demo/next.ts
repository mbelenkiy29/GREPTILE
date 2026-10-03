/** Binds the public demo endpoints (R3.7) to Next.js route handlers with production dependencies. */
import { db } from "@/lib/db";
import { authEnv, demoEnv } from "@/lib/env";
import { bullQueue } from "@/lib/jobs/queue";
import { errorMessage, log } from "@/lib/log";
import { handleDemoChallenge, handleDemoSubmit, type DemoHttpDeps } from "./http";

function deps(): DemoHttpDeps {
  const auth = authEnv();
  return { db: db(), queue: bullQueue, env: demoEnv(), secret: auth.APP_SECRET, appUrl: auth.APP_URL, log: log.child({ component: "demo" }) };
}

function handler(fn: (req: Request, d: DemoHttpDeps) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req, deps());
    } catch (err) {
      log.error("demo endpoint failed", { error: errorMessage(err) });
      return Response.json({ error: "server_error", message: "Something went wrong. Try again." }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  };
}

export const challengeRoute = handler(handleDemoChallenge);
export const submitRoute = handler(handleDemoSubmit);
