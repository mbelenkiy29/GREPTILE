"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { randomToken } from "@/lib/crypto";
import { isSetupField, SETUP_COOKIE, SETUP_COOKIE_PATH, SETUP_MAX_AGE_S, setupFormSchema } from "@/lib/setup/github-app";
import { setupContext, setupCookieSecure } from "@/lib/setup/next";

/**
 * Step 1 of the GitHub App setup (R6.25): validates the account and App name, and binds a new flow to this browser
 * with a random nonce in an HttpOnly cookie. Server actions only run for same-origin requests.
 */
export async function startGitHubAppSetup(formData: FormData) {
  const { env, access } = await setupContext();
  if (!access.allowed) notFound();
  const input = { owner: String(formData.get("owner") ?? ""), name: String(formData.get("name") ?? ""), public: formData.get("public") === "on" };
  const parsed = setupFormSchema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    redirect(`/setup/github-app?${new URLSearchParams({ invalid: isSetupField(field) ? field : "name", owner: input.owner.slice(0, 100), name: input.name.slice(0, 100) })}`);
  }
  (await cookies()).set(SETUP_COOKIE, randomToken(24), {
    httpOnly: true,
    sameSite: "lax",
    secure: setupCookieSecure(env),
    path: SETUP_COOKIE_PATH,
    maxAge: SETUP_MAX_AGE_S,
  });
  const { owner, name } = parsed.data;
  redirect(`/setup/github-app?${new URLSearchParams({ step: "create", owner, name, ...(parsed.data.public ? { public: "1" } : {}) })}`);
}
