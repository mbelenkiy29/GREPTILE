import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import {
  backend,
  cookieOptions,
  origin,
  seal,
  signSession,
  unseal,
} from "../../../../src/server";
import { Github } from "../../../../src/github";

export async function GET(request: Request) {
  const url = new URL(request.url),
    jar = await cookies();
  const cookie = jar.get("openreview_oauth_state")?.value;
  jar.delete("openreview_oauth_state");
  try {
    if (!cookie || !url.searchParams.get("code"))
      throw new Error("Missing OAuth state or code");
    const saved = await unseal(cookie);
    if (saved.state !== url.searchParams.get("state"))
      throw new Error("OAuth state mismatch");
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code: url.searchParams.get("code"),
          redirect_uri: `${origin()}/api/auth/callback`,
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error("GitHub OAuth exchange failed");
    const token = z
      .object({ access_token: z.string().min(1) })
      .parse(await response.json()).access_token;
    const user = await new Github(token).request(
      "/user",
      z.object({ id: z.number(), login: z.string(), avatar_url: z.string() }),
    );
    const userId = await backend().mutation(api.users.login, {
      secret: process.env.SERVICE_SECRET ?? "",
      githubId: user.id,
      login: user.login,
      avatar: user.avatar_url,
    });
    jar.set("openreview_session", await signSession(userId), {
      ...cookieOptions,
      maxAge: 7 * 86400,
    });
    jar.set("openreview_github_setup", await seal({ token }), {
      ...cookieOptions,
      maxAge: 600,
    });
    return NextResponse.redirect(`${origin()}/dashboard`);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "auth.failed",
        error: error instanceof Error ? error.message : "Authentication failed",
      }),
    );
    return NextResponse.redirect(`${origin()}/?error=signin`);
  }
}
