import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth";
import { env } from "@/lib/env";
import { signInstallState } from "@/lib/github/install-state";

/** Starts the GitHub App install for the active org (R1.1). */
export async function GET() {
  const { orgId } = await requireOrg();
  const e = env();
  const url = new URL(`https://github.com/apps/${e.GITHUB_APP_SLUG}/installations/new`);
  url.searchParams.set("state", signInstallState(e.APP_SECRET, orgId));
  return NextResponse.redirect(url);
}
