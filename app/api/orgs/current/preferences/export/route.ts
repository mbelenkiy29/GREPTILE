import { db } from "@/lib/db";
import { authEnv } from "@/lib/env";
import { createPreferencesExportHandler } from "@/lib/learning/export-handler";

export const dynamic = "force-dynamic";

/** Downloads the active org's learned preferences as JSON (R6.10). */
export const GET = createPreferencesExportHandler(() => ({ db: db(), clock: { now: new Date(), ttlDays: authEnv().SESSION_TTL_DAYS } }));
