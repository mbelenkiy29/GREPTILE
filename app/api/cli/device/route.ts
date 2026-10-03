import { deviceRoute } from "@/lib/cli/next";

export const dynamic = "force-dynamic";

/** Starts an `openreview login` device-code flow (R3.5). */
export const POST = deviceRoute;
