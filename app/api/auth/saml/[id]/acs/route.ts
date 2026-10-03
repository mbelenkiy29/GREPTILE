import { createSamlAcsHandler } from "@/lib/sso/handlers";
import { ssoHandlerDeps } from "@/lib/sso/next";

export const dynamic = "force-dynamic";

/** SAML assertion consumer service (R4.6). */
export const POST = createSamlAcsHandler(ssoHandlerDeps);
