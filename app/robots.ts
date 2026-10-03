import type { MetadataRoute } from "next";
import { DISALLOWED_PATHS, siteOrigin } from "@/lib/site";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: DISALLOWED_PATHS }],
    sitemap: `${origin}/sitemap.xml`,
  };
}
