import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, origin, seal, cookieOptions } from "../../../../../src/server";
import { atlassianAuthorization } from "../../../../../src/atlassian";

export async function GET(request: Request) {
  const identity = await current(), organizationId = new URL(request.url).searchParams.get("organization");
  if (!identity.organizations.some(o => o._id === organizationId && ["owner", "admin"].includes(o.role)))
    return NextResponse.json({error: "Workspace admin required"}, {status: 403});
  if (!process.env.ATLASSIAN_CLIENT_ID || !process.env.ATLASSIAN_CLIENT_SECRET)
    return NextResponse.json({error: "Configure ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET and register the callback URL shown in integrations setup."}, {status: 503});
  const state = randomBytes(32).toString("base64url");
  const url = atlassianAuthorization(process.env.ATLASSIAN_CLIENT_ID, origin()+"/api/integrations/atlassian/callback", state);
  (await cookies()).set("openreview_atlassian_oauth", await seal({state, organizationId, userId: identity.user._id, expiresAt: Date.now()+600000}), {...cookieOptions, maxAge:600});
  return NextResponse.redirect(url);
}
