import { createSsoLookupHandler } from "@/lib/sso/handlers";
import { ssoHandlerDeps } from "@/lib/sso/next";

export const dynamic = "force-dynamic";

/** Finds the SSO connection for an email or org slug from the sign-in page (R4.6). */
export const POST = createSsoLookupHandler(ssoHandlerDeps);
