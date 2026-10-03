import { authConfig } from "@/lib/auth/config";
import { createGitHubSignInCallbackHandler } from "@/lib/auth/handlers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GitHub redirects here after the user authorizes sign-in (R6.1). */
export const GET = createGitHubSignInCallbackHandler(() => ({ db: db(), config: authConfig() }));
