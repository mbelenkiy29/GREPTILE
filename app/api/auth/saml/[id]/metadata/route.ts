import { createSamlMetadataHandler } from "@/lib/sso/handlers";
import { ssoHandlerDeps } from "@/lib/sso/next";

export const dynamic = "force-dynamic";

/** SAML service provider metadata; its URL is also the SP entity id (R4.6). */
export const GET = createSamlMetadataHandler(ssoHandlerDeps);
