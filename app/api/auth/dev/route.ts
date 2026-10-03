import { authConfig } from "@/lib/auth/config";
import { createDevLoginHandler } from "@/lib/auth/handlers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Local developer sign-in for development and Playwright; 404 unless AUTH_DEV_LOGIN=true outside production. */
export const POST = createDevLoginHandler(() => ({ db: db(), config: authConfig() }));
