/** Production dependencies for the SSO route handlers (R4.6). */
import { authConfig } from "@/lib/auth/config";
import { db } from "@/lib/db";
import { enterpriseEnv } from "@/lib/env";
import { publicLimiter } from "@/lib/security/rate-limit";
import type { SsoHandlerDeps } from "./handlers";

export function ssoHandlerDeps(): SsoHandlerDeps {
  const e = enterpriseEnv();
  return {
    db: db(),
    config: authConfig(),
    net: { allowPrivate: e.SSO_ALLOW_PRIVATE_ISSUERS },
    rateLimit: { limiter: publicLimiter(), perMinute: e.PUBLIC_RATE_LIMIT_PER_MINUTE },
  };
}
