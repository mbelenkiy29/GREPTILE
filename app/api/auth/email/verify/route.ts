import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { backend, origin } from "../../../../../src/server";
import { newSession, safeNext } from "../../../../../src/identity";
import { startSession } from "../../../../../src/oauth-flow";

export async function GET(request: Request) {
  const url = new URL(request.url), token = url.searchParams.get("token") ?? "";
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return NextResponse.redirect(`${origin()}/?error=signin`);
  const session = newSession();
  const userId = await backend().mutation(api.identity.consumeLoginToken, { secret: process.env.SERVICE_SECRET ?? "", tokenHash: createHash("sha256").update(token).digest("hex"), sessionHash: session.hash, userAgent: (await headers()).get("user-agent")?.slice(0, 200) ?? undefined }).catch(() => null);
  if (!userId) return NextResponse.redirect(`${origin()}/?error=link`);
  await startSession(userId, session.sid);
  return NextResponse.redirect(origin() + safeNext(url.searchParams.get("next")));
}
