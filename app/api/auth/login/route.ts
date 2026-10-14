import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieOptions, origin, seal } from "../../../../src/server";

export async function GET() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId)
    return NextResponse.json(
      {
        error:
          "Configure GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable sign-in.",
      },
      { status: 503 },
    );
  const state = randomBytes(32).toString("hex");
  (await cookies()).set("openreview_oauth_state", await seal({ state }), {
    ...cookieOptions,
    maxAge: 600,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${origin()}/api/auth/callback`);
  return NextResponse.redirect(url);
}
