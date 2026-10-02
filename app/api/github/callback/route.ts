import { authConfig } from "@/lib/auth/config";
import { createInstallCallbackHandler } from "@/lib/auth/install";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import { enqueueIndexForNewRepos } from "@/lib/jobs/enqueue";

export const dynamic = "force-dynamic";

/**
 * GitHub redirects here after an install. The installation is linked to the org that started the flow only after
 * GitHub confirms the signed-in user can access it (R1.1).
 */
export const GET = createInstallCallbackHandler(() => ({
  db: db(),
  config: { ...authConfig(), appSlug: env().GITHUB_APP_SLUG },
  host: gitHost(),
  enqueue: (repos) => enqueueIndexForNewRepos(repos),
}));
