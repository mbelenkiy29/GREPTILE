import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security/headers";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // `next dev` would otherwise append its own agent-rules block to CLAUDE.md (the project's instructions file).
  agentRules: false,
  // Enables `forbidden()` so role checks render a real 403 page (lib/auth requireOrg).
  experimental: { authInterrupts: true },
  // Security headers on every page and API route (R6.20).
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders({ development: process.env.NODE_ENV === "development" }) },
      // The GitHub App setup pages show one-time credentials (R6.25): never cache them or leak the code in a referrer.
      {
        source: "/setup/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
