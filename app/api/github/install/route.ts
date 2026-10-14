import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, seal, cookieOptions } from "../../../../src/server";

export async function GET(request: Request) {
  const user = await current();
  const orgId = new URL(request.url).searchParams.get("organization");
  const membership = user.organizations.find((o) => o._id === orgId);
  if (!membership || !["owner", "admin"].includes(membership.role))
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
  const state = randomBytes(32).toString("hex");
  (await cookies()).set(
    "openreview_install_state",
    await seal({ state, organizationId: orgId }),
    { ...cookieOptions, maxAge: 600 },
  );
  return NextResponse.redirect(
    `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${state}`,
  );
}
