import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, seal, unseal, cookieOptions, origin } from "../../../../src/server";
import { installHref, installReturnPath } from "../../../../src/github-install";

export async function GET(request: Request) {
  const user = await current();
  const url = new URL(request.url),
    orgId = url.searchParams.get("organization"),
    returnTo = installReturnPath(url.searchParams.get("returnTo"));
  const membership = user.organizations.find((o) => o._id === orgId);
  if (!orgId || !membership || !["owner", "admin"].includes(membership.role))
    return NextResponse.json(
      { error: "Workspace admin required" },
      { status: 403 },
    );
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug)
    return NextResponse.json(
      { error: "Configure GITHUB_APP_SLUG" },
      { status: 503 },
    );
  const jar = await cookies();
  // The callback verifies the installation with a fresh GitHub user token. When the sign-in token
  // has expired, or the user signed in another way, get one first; this does not sign in again.
  const setup = jar.get("openreview_github_setup")?.value;
  if (!setup || !(await unseal(setup).then(() => true, () => false))) {
    if (!process.env.GITHUB_CLIENT_ID)
      return NextResponse.json(
        { error: "Configure GITHUB_CLIENT_ID to verify GitHub App installations" },
        { status: 503 },
      );
    const next = installHref(orgId, returnTo);
    return NextResponse.redirect(`${origin()}/api/auth/login?purpose=github-install&next=${encodeURIComponent(next)}`);
  }
  const state = randomBytes(32).toString("hex");
  jar.set(
    "openreview_install_state",
    await seal({ state, organizationId: orgId, userId: user.user._id, returnTo }),
    { ...cookieOptions, maxAge: 600 },
  );
  return NextResponse.redirect(
    `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${state}`,
  );
}
