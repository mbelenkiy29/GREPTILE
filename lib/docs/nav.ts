/**
 * Documentation navigation (R5.3): the order of the sidebar and of prev/next links. Every file in `content/docs`
 * appears here exactly once (a test checks both directions). The slug is the file name without `.mdx`; `index` is the
 * docs home at `/docs`.
 */

export interface NavSection {
  title: string;
  slugs: readonly string[];
}

export const DOCS_NAV: readonly NavSection[] = [
  { title: "Getting started", slugs: ["index", "quickstart", "github-app", "gitlab", "bitbucket"] },
  { title: "Reviews", slugs: ["configuration", "review-modes", "rules", "learning", "knowledge-base", "conversations"] },
  { title: "Integrations", slugs: ["cli", "mcp", "api"] },
  { title: "Operating OpenReview", slugs: ["self-hosting", "sso", "security", "troubleshooting", "faq"] },
];

/** Every slug in navigation order. */
export const DOC_SLUGS: readonly string[] = DOCS_NAV.flatMap((s) => s.slugs);

/** The URL of a doc page. */
export function docHref(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

/** The slug for a `[[...slug]]` route parameter, or null when it names no page. */
export function slugFromParams(parts: string[] | undefined): string | null {
  if (!parts || parts.length === 0) return "index";
  if (parts.length !== 1) return null;
  const slug = parts[0]!;
  return slug !== "index" && DOC_SLUGS.includes(slug) ? slug : null;
}

/** The pages before and after `slug` in navigation order. */
export function neighbours(slug: string): { prev: string | null; next: string | null } {
  const i = DOC_SLUGS.indexOf(slug);
  return { prev: i > 0 ? DOC_SLUGS[i - 1]! : null, next: i >= 0 && i < DOC_SLUGS.length - 1 ? DOC_SLUGS[i + 1]! : null };
}
