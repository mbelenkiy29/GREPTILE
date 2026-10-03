import type { NextRequest } from "next/server";
import { authConfig } from "@/lib/auth/config";
import { authGate } from "@/lib/auth/proxy";

/** Cookie-presence gate for signed-in areas; sessions are validated server-side (lib/auth). */
export function proxy(req: NextRequest) {
  return authGate(req, authConfig());
}

export const config = {
  matcher: ["/dashboard/:path*", "/orgs/:path*", "/invite/:path*", "/api/github/:path*"],
};
