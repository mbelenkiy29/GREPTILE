import { createSsoStartHandler } from "@/lib/sso/handlers";
import { ssoHandlerDeps } from "@/lib/sso/next";

export const dynamic = "force-dynamic";

/** Starts SSO sign-in through one connection (R4.6). */
export const GET = createSsoStartHandler(ssoHandlerDeps);
