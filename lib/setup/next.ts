/**
 * Next.js bindings for the GitHub App setup pages (R6.25): the env, the signed-in user (if any), and who may use the
 * pages, read without the GitHub App variables the rest of the app requires.
 */
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { setupEnv, type SetupEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/log";
import { setupAccess, type SetupAccess } from "./github-app";

export interface SetupContext {
  env: SetupEnv;
  access: SetupAccess;
}

export async function setupContext(): Promise<SetupContext> {
  const env = setupEnv();
  let user: { id: string; email: string | null } | null = null;
  try {
    const session = await getSession();
    if (session) user = { id: session.user.id, email: session.user.email };
  } catch (err) {
    // Sessions need APP_SECRET; on a fresh install without it the visitor is treated as signed out.
    log.child({ component: "setup" }).warn("could not read the session on the setup page", { error: errorMessage(err) });
  }
  return { env, access: await setupAccess(db(), env, user) };
}

/** `Secure` on the setup cookie whenever the app is served over https, and always in production. */
export function setupCookieSecure(env: Pick<SetupEnv, "APP_URL" | "NODE_ENV">): boolean {
  return env.NODE_ENV === "production" || new URL(env.APP_URL).protocol === "https:";
}
