import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Enables `forbidden()` so role checks render a real 403 page (lib/auth requireOrg).
  experimental: { authInterrupts: true },
};

export default nextConfig;
