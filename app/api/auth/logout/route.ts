import { authConfig } from "@/lib/auth/config";
import { createLogoutHandler } from "@/lib/auth/handlers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Signs out: deletes the session and clears the cookie (same-origin POST only). */
export const POST = createLogoutHandler(() => ({ db: db(), config: authConfig() }));
