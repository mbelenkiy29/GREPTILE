import { NextResponse } from "next/server";
import { beginOAuth } from "../../../../../src/oauth-flow";
import { gitlabAuthorizeUrl } from "../../../../../src/identity";

export async function GET(request: Request) {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID;
  if (!clientId || !process.env.GITLAB_OAUTH_CLIENT_SECRET) return NextResponse.json({ error: "Configure GITLAB_OAUTH_CLIENT_ID and GITLAB_OAUTH_CLIENT_SECRET to enable GitLab sign-in." }, { status: 503 });
  return beginOAuth(request, "gitlab", (state, redirectUri) => gitlabAuthorizeUrl(clientId, redirectUri, state));
}
