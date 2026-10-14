import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const origin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined;
  return { rules: { userAgent: "*", allow: ["/", "/docs", "/changelog"], disallow: ["/dashboard", "/api", "/fix", "/invite"] }, ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}) };
}
