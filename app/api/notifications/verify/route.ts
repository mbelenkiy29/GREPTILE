import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { backend, origin } from "../../../../src/server";

// Email verification link: proves the member controls the address (no session required).
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const ok = /^[A-Za-z0-9_-]{40,64}$/.test(token) && await backend().mutation(api.notifications.verifyEmail, { tokenHash: createHash("sha256").update(token).digest("hex") }).catch(() => false);
  return NextResponse.redirect(origin() + `/dashboard/settings/notifications?email=${ok ? "verified" : "invalid"}`);
}
