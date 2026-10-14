import { NextResponse } from "next/server";
import { beginOAuth } from "../../../../../src/oauth-flow";
import { googleAuthorizeUrl } from "../../../../../src/identity";

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) return NextResponse.json({ error: "Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in." }, { status: 503 });
  return beginOAuth(request, "google", (state, redirectUri) => googleAuthorizeUrl(clientId, redirectUri, state));
}
