import { cookies } from "next/headers";
import { z } from "zod";
import { cookieOptions, seal } from "../../../../src/server";
import { Github } from "../../../../src/github";
import { finishOAuth } from "../../../../src/oauth-flow";

export async function GET(request: Request) {
  let accessToken = "", githubUserId = 0;
  return finishOAuth(request, "github", async (code, redirectUri) => {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("GitHub OAuth exchange failed");
    accessToken = z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
    const user = await new Github(accessToken).request("/user", z.object({ id: z.number(), login: z.string(), avatar_url: z.string() }));
    githubUserId = user.id;
    // GitHub emails are not requested (no user:email scope), so GitHub never links by email.
    return { providerUserId: String(user.id), login: user.login, avatar: user.avatar_url, emailVerified: false };
  }, async () => {
    // Short-lived token for the GitHub App installation flow that may follow sign-in.
    (await cookies()).set("openreview_github_setup", await seal({ token: accessToken, githubUserId }), { ...cookieOptions, maxAge: 600 });
  });
}
