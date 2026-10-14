import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, origin, seal, cookieOptions } from "../../../../../src/server";
import { notionAuthorization } from "../../../../../src/notion";
import { offline } from "../../../../../src/egress";

export async function GET(request: Request) {
  const identity = await current(), organizationId = new URL(request.url).searchParams.get("organization");
  if (!identity.organizations.some(o => o._id === organizationId && ["owner", "admin"].includes(o.role)))
    return NextResponse.json({error: "Workspace admin required"}, {status: 403});
  if (offline())
    return NextResponse.json({error: "Requirements integrations are turned off in offline mode (OPENREVIEW_OFFLINE=true)."}, {status: 503});
  if (!process.env.NOTION_CLIENT_ID || !process.env.NOTION_CLIENT_SECRET)
    return NextResponse.json({error: "Configure NOTION_CLIENT_ID and NOTION_CLIENT_SECRET and register the callback URL shown in integrations setup."}, {status: 503});
  const state = randomBytes(32).toString("base64url");
  const url = notionAuthorization(process.env.NOTION_CLIENT_ID, origin()+"/api/integrations/notion/callback", state);
  (await cookies()).set("openreview_notion_oauth", await seal({state, organizationId, userId: identity.user._id, expiresAt: Date.now()+600000}), {...cookieOptions, maxAge:600});
  return NextResponse.redirect(url);
}
