import { tokenRoute } from "@/lib/cli/next";

export const dynamic = "force-dynamic";

/** The CLI's poll: returns the new API key once the login is approved (R3.5). */
export const POST = tokenRoute;
