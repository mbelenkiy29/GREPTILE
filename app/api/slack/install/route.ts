import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, origin, seal, cookieOptions } from "../../../../src/server";
import { slackAuthorizeUrl } from "../../../../src/slack";
import { offline } from "../../../../src/egress";

// Starts the Slack app install for a workspace (owners and admins only).
export async function GET(request: Request) {
  const identity = await current(), organizationId = new URL(request.url).searchParams.get("organization");
  if (!identity.organizations.some((o) => o._id === organizationId && ["owner", "admin"].includes(o.role)))
    return NextResponse.json({ error: "Workspace admin required" }, { status: 403 });
  if (offline())
    return NextResponse.json({ error: "Slack is turned off in offline mode (OPENREVIEW_OFFLINE=true)." }, { status: 503 });
  if (!process.env.SLACK_CLIENT_ID)
    return NextResponse.json({ error: "Configure SLACK_CLIENT_ID (see docs/slack.md)." }, { status: 503 });
  const state = randomBytes(32).toString("base64url");
  (await cookies()).set("openreview_slack_oauth", await seal({ state, organizationId, userId: identity.user._id, expiresAt: Date.now() + 600000 }), { ...cookieOptions, maxAge: 600 });
  return NextResponse.redirect(slackAuthorizeUrl(process.env.SLACK_CLIENT_ID, origin() + "/api/slack/callback", state));
}
