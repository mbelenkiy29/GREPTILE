import { authConfig } from "@/lib/auth/config";
import { createInstallStartHandler } from "@/lib/auth/install";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Starts the GitHub App install for the active org; requires `repos.manage` (R1.1). */
export const GET = createInstallStartHandler(() => ({ db: db(), config: { ...authConfig(), appSlug: env().GITHUB_APP_SLUG } }));
