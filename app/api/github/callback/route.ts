import { NextResponse, type NextRequest } from "next/server";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { InstallationOwnershipError, completeInstallation } from "@/lib/data/installations";
import { env } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import { verifyInstallState } from "@/lib/github/install-state";
import { enqueueIndexForNewRepos } from "@/lib/jobs/enqueue";

/** GitHub redirects here after install; links the installation to the org that started it (R1.1). */
export async function GET(req: NextRequest) {
  const session = await requireOrg();
  const params = req.nextUrl.searchParams;
  const state = verifyInstallState(env().APP_SECRET, params.get("state") ?? "");
  const installationId = Number(params.get("installation_id"));
  const back = (q: string) => NextResponse.redirect(new URL(`/dashboard?${q}`, req.url));

  if (!state || state.orgId !== session.orgId) return back("install=invalid_state");
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return back("install=missing_installation");

  try {
    const { repos } = await completeInstallation(db(), gitHost(), {
      orgId: session.orgId,
      orgName: session.orgName,
      installationId,
    });
    await enqueueIndexForNewRepos(repos);
    return back("install=ok");
  } catch (err) {
    if (err instanceof InstallationOwnershipError) return back("install=owned_elsewhere");
    throw err;
  }
}
