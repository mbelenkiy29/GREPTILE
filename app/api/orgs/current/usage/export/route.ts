import { createUsageExportHandler } from "@/lib/data/usage-export";
import { db } from "@/lib/db";
import { authEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Downloads the active org's usage events for a period as CSV (R4.3). */
export const GET = createUsageExportHandler(() => ({ db: db(), clock: { now: new Date(), ttlDays: authEnv().SESSION_TTL_DAYS } }));
