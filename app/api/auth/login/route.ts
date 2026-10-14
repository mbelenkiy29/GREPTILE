import { NextResponse } from "next/server";
import { beginOAuth } from "../../../../src/oauth-flow";

export async function GET(request: Request) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId)
    return NextResponse.json(
      {
        error:
          "Configure GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable sign-in.",
      },
      { status: 503 },
    );
  return beginOAuth(request, "github", (state, redirectUri) => {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    return url.toString();
  });
}
