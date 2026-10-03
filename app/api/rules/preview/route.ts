import { db } from "@/lib/db";
import { createRulePreviewHandler } from "@/lib/data/rules";
import { authEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Live "matches N files" preview for a rule's path globs (R6.11). */
export const GET = createRulePreviewHandler(() => ({ db: db(), clock: { now: new Date(), ttlDays: authEnv().SESSION_TTL_DAYS } }));
