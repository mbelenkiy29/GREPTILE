import { authConfig } from "@/lib/auth/config";
import { createGitHubSignInStartHandler } from "@/lib/auth/handlers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Starts "Sign in with GitHub" (R6.1). */
export const GET = createGitHubSignInStartHandler(() => ({ db: db(), config: authConfig() }));
