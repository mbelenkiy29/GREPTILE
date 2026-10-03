import { db } from "@/lib/db";
import { createIndexStatusHandler } from "@/lib/data/onboarding";
import { authEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Index progress of the active org's enabled repositories, polled by the onboarding wizard (R6.2). */
export const GET = createIndexStatusHandler(() => ({ db: db(), clock: { now: new Date(), ttlDays: authEnv().SESSION_TTL_DAYS } }));
