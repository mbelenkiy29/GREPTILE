import { authConfig } from "@/lib/auth/config";
import { createGitHubSignInStartHandler } from "@/lib/auth/handlers";
import { db } from "@/lib/db";
import { withRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/** Starts "Sign in with GitHub" (R6.1). */
export const GET = withRateLimit("auth.github.start", createGitHubSignInStartHandler(() => ({ db: db(), config: authConfig() })));
