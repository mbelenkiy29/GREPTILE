import { loginConnection, samlFor, ssoBase } from "../../../../../src/sso-web";

export const dynamic = "force-dynamic";
// SAML service-provider metadata for this connection (entity ID = this URL, ACS = …/acs).
export async function GET(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const c = await loginConnection({ connectionId }).catch(() => null);
  if (!c || c.protocol !== "saml") return new Response("Not found", { status: 404 });
  return new Response(samlFor(ssoBase(request.url), c).generateServiceProviderMetadata(null), { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" } });
}
