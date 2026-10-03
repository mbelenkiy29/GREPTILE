/** Binds the CLI login endpoints (R3.5) to Next.js route handlers with production dependencies. */
import { RedisRateLimiter } from "@/lib/api/rate-limit";
import { db } from "@/lib/db";
import { apiEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/log";
import { redis } from "@/lib/redis";
import { pollDeviceToken, startDeviceLogin, type DeviceDeps } from "./device";

let limiter: RedisRateLimiter | undefined;

function deps(): DeviceDeps {
  const cliLog = log.child({ component: "cli-login" });
  limiter ??= new RedisRateLimiter(redis, cliLog);
  return { db: db(), now: () => new Date(), limiter, appUrl: apiEnv().APP_URL, log: cliLog };
}

function handler(fn: (d: DeviceDeps, req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(deps(), req);
    } catch (err) {
      log.error("CLI login endpoint failed", { error: errorMessage(err) });
      return Response.json({ error: "server_error", error_description: "Something went wrong. Try again." }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  };
}

export const deviceRoute = handler(startDeviceLogin);
export const tokenRoute = handler(pollDeviceToken);
