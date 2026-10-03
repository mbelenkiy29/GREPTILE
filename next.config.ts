import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security/headers";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Enables `forbidden()` so role checks render a real 403 page (lib/auth requireOrg).
  experimental: { authInterrupts: true },
  // Security headers on every page and API route (R6.20).
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders({ development: process.env.NODE_ENV === "development" }) }];
  },
};

export default nextConfig;
