/**
 * Public site metadata helpers (R5.1–R5.3): the canonical origin and the pages listed in the sitemap.
 */
import { DOC_SLUGS, docHref } from "@/lib/docs/nav";

/** The site's public origin from APP_URL (no trailing slash); falls back to localhost when unset or invalid. */
export function siteOrigin(source: Record<string, string | undefined> = process.env): string {
  try {
    return new URL(source.APP_URL || "http://localhost:3000").origin;
  } catch {
    return "http://localhost:3000";
  }
}

/** Public, indexable paths: the landing page, pricing, and every docs page. */
export function publicPaths(): string[] {
  return ["/", "/pricing", ...DOC_SLUGS.map(docHref)];
}

/** Paths crawlers should skip: signed-in areas, APIs, and per-visitor pages. */
export const DISALLOWED_PATHS = ["/api/", "/dashboard", "/onboarding", "/orgs", "/invite/", "/cli/", "/try/"];
