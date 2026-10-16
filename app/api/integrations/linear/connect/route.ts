import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, origin, seal, cookieOptions } from "../../../../../src/server";
import { linearAuthorization } from "../../../../../src/linear";
import { offline } from "../../../../../src/egress";

export async function GET(request: Request) {
  const identity = await current(), organizationId = new URL(request.url).searchParams.get("organization");
  if (!identity.organizations.some(o => o._id === organizationId && ["owner", "admin"].includes(o.role)))
    return NextResponse.json({error: "Workspace admin required"}, {status: 403});
  if (offline())
    return NextResponse.json({error: "Requirements integrations are turned off in offline mode (OPENREVIEW_OFFLINE=true)."}, {status: 503});
  if (!process.env.LINEAR_CLIENT_ID)
    return NextResponse.json({error: "Configure LINEAR_CLIENT_ID and register the callback URL shown in integrations setup."}, {status: 503});
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  const url = linearAuthorization(process.env.LINEAR_CLIENT_ID, origin()+"/api/integrations/linear/callback", state, verifier);
  (await cookies()).set("openreview_linear_oauth", await seal({state, verifier, organizationId, userId: identity.user._id, expiresAt: Date.now()+600000}), {...cookieOptions, maxAge:600});
  return NextResponse.redirect(url);
}
