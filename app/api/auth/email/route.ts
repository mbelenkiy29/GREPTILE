import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { backend, origin } from "../../../../src/server";
import { safeNext } from "../../../../src/identity";
import { authPagePath } from "../../../../src/auth-pages";

// Request a magic link. The response is the same whether or not an account exists.
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null), email = String(form?.get("email") ?? "").slice(0, 254), next = safeNext(String(form?.get("next") ?? ""));
  // Back to the page the visitor started on (sign in or sign up), with the result.
  const page = origin() + authPagePath(String(form?.get("from") ?? ""));
  try { await backend().action(api.identityJobs.requestMagicLink, { secret: process.env.SERVICE_SECRET ?? "", email, next }); }
  catch { return NextResponse.redirect(`${page}?email=error`, 303); }
  return NextResponse.redirect(`${page}?email=sent`, 303);
}
