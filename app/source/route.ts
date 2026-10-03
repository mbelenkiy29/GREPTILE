import { siteEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Redirects to the source code of the running version (SOURCE_CODE_URL), which AGPL-3.0 §13 asks a network service to
 * offer its users. The public site links here so statically generated pages follow the operator's setting.
 */
export function GET() {
  return new Response(null, { status: 307, headers: { location: siteEnv().SOURCE_CODE_URL, "cache-control": "no-store" } });
}
