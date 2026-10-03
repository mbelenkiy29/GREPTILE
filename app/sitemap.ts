import type { MetadataRoute } from "next";
import { publicPaths, siteOrigin } from "@/lib/site";

// The origin is each deployment's APP_URL, known only at runtime.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return publicPaths().map((p) => ({
    url: `${origin}${p}`,
    changeFrequency: p.startsWith("/docs") ? "weekly" : "monthly",
    priority: p === "/" ? 1 : p === "/pricing" ? 0.8 : 0.6,
  }));
}
