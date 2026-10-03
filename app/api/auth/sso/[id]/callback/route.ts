import { createOidcCallbackHandler } from "@/lib/sso/handlers";
import { ssoHandlerDeps } from "@/lib/sso/next";

export const dynamic = "force-dynamic";

/** OIDC redirect URI (R4.6). */
export const GET = createOidcCallbackHandler(ssoHandlerDeps);
