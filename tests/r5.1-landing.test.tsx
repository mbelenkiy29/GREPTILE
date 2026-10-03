import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import DocPage from "@/app/(marketing)/docs/[[...slug]]/page";
import MarketingLayout from "@/app/(marketing)/layout";
import { LandingPage } from "@/components/marketing/LandingPage";
import { PricingView } from "@/components/marketing/PricingView";
import { SiteFooter, SiteHeader, SOURCE_HREF } from "@/components/marketing/SiteChrome";
import { billingConfig } from "@/lib/billing/plans";
import { DOC_SLUGS } from "@/lib/docs/nav";
import { billingEnv } from "@/lib/env";
import { EXAMPLE_FINDINGS, INTEGRATIONS, LANDING_FAQ, PIPELINE_STEPS } from "@/lib/marketing/content";
import { DISALLOWED_PATHS, publicPaths, siteOrigin } from "@/lib/site";

const root = path.resolve(import.meta.dirname, "..");
// Built at runtime so this file never contains the name it checks for.
const FORBIDDEN = new RegExp(["grep", "tile"].join(""), "i");

const landing = (demoEnabled: boolean) => renderToStaticMarkup(<LandingPage demoEnabled={demoEnabled} />);

/** Every `href` of the `<a>` elements with `data-cta` in rendered HTML. */
function ctas(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<a [^>]*>/g)) {
    const cta = /data-cta="([^"]+)"/.exec(tag)?.[1];
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    if (cta && href) out[cta] = href;
  }
  return out;
}

function filesUnder(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full, exts);
    return exts.some((e) => name.endsWith(e)) ? [full] : [];
  });
}

describe("landing page", () => {
  test("R5.1 renders every section: hero, how it works, examples, personalization, integrations, security, FAQ, CTA", () => {
    const html = landing(false);
    for (const s of ["hero", "how-it-works", "examples", "personalization", "integrations", "security", "faq", "cta"]) {
      expect(html, s).toContain(`data-section="${s}"`);
    }
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const step of PIPELINE_STEPS) expect(html).toContain(`data-step="${step.id}"`);
    for (const it of INTEGRATIONS) expect(html).toContain(`data-integration="${it.id}"`);
    for (const q of LANDING_FAQ) expect(html).toContain(q.q.replace(/'/g, "&#x27;"));
    // The pipeline diagram is an inline SVG with an accessible name, not an external image.
    expect(html).toContain('class="pipeline-diagram"');
    expect(html).toContain("The OpenReview review pipeline");
    expect(html).not.toMatch(/<img\b/);
    // Security & self-hosting points.
    for (const point of ["AGPL-3.0.", "Offline bundle.", "Bring your own model.", "SSO.", "Audit log."]) expect(html).toContain(point);
    // Integrations named in the brief.
    for (const name of ["GitHub", "GitLab", "Bitbucket Cloud", "CLI", "MCP server", "Claude Code plugin", "REST API"]) expect(html).toContain(name);
  });

  test("R5.1 primary CTAs link to sign-in and the self-hosting docs", () => {
    const links = ctas(landing(false));
    expect(links["get-started"]).toBe("/sign-in");
    expect(links["self-host"]).toBe("/docs/self-hosting");
  });

  test("R5.1 shows the Try it on a PR CTA only when the public demo is enabled", () => {
    expect(ctas(landing(false)).try).toBeUndefined();
    expect(landing(false)).not.toContain('href="/try"');
    expect(ctas(landing(true)).try).toBe("/try");
    expect(landing(true)).toContain("Try it on a PR");
  });

  test("R5.1 example findings use the finding card styles and are each labeled as an example", () => {
    const html = landing(false);
    const cards = html.match(/<article class="finding example-finding"[^>]*>/g) ?? [];
    expect(cards).toHaveLength(EXAMPLE_FINDINGS.length);
    for (const card of cards) expect(card).toContain("data-example");
    expect(html.match(/>Example</g)?.length).toBe(EXAMPLE_FINDINGS.length);
    expect(html).toMatch(/illustrative examples written for a fictional codebase/);
    expect(html).toContain("Illustrative example — not from a real repository.");
    // No invented metrics: no percentages of bugs caught, no customer counts.
    expect(html).not.toMatch(/catch(es)? \d+%|\d+% (of|fewer|more) bugs|trusted by|customers/i);
  });

  test("R5.1 header and footer link to docs, pricing, sign-in, and the source code (AGPL-3.0 section 13)", () => {
    const header = renderToStaticMarkup(<SiteHeader sourceUrl={SOURCE_HREF} />);
    expect(header).toContain('href="/docs"');
    expect(header).toContain('href="/pricing"');
    expect(header).toContain('href="/sign-in"');
    expect(header).toContain(`href="${SOURCE_HREF}"`);
    const footer = renderToStaticMarkup(<SiteFooter sourceUrl="https://github.com/acme/openreview-fork" />);
    expect(footer).toMatch(/<a href="https:\/\/github.com\/acme\/openreview-fork"[^>]*data-source-link=""[^>]*>Source code on GitHub<\/a>/);
    expect(footer).toContain('href="/pricing"');
    expect(footer).toContain('href="/docs/quickstart"');
    expect(footer).toContain("AGPL-3.0");
    const layout = renderToStaticMarkup(<MarketingLayout>page</MarketingLayout>);
    expect(layout).toContain('<main id="main"');
    expect(layout).toContain('href="#main"');
  });

  test("R5.1 robots and sitemap cover the public pages and skip signed-in areas", () => {
    expect(siteOrigin({ APP_URL: "https://review.example.com/" })).toBe("https://review.example.com");
    expect(siteOrigin({ APP_URL: "not a url" })).toBe("http://localhost:3000");
    const paths = publicPaths();
    expect(paths).toEqual(expect.arrayContaining(["/", "/pricing", "/docs", "/docs/self-hosting"]));
    expect(paths).toHaveLength(2 + DOC_SLUGS.length);
    expect(DISALLOWED_PATHS).toEqual(expect.arrayContaining(["/api/", "/dashboard"]));
  });

  test("R5.1 no rendered marketing or docs page, content file, or built page mentions the reference product (H1)", async () => {
    const rendered: string[] = [landing(true), landing(false)];
    rendered.push(renderToStaticMarkup(<PricingView config={billingConfig(billingEnv({}))} credits={{ fast: 1, standard: 2, deep: 4 }} />));
    for (const slug of DOC_SLUGS) {
      const el = await DocPage({ params: Promise.resolve({ slug: slug === "index" ? [] : [slug] }) });
      rendered.push(renderToStaticMarkup(el));
    }
    for (const html of rendered) expect(html).not.toMatch(FORBIDDEN);

    const sources = [
      ...filesUnder(path.join(root, "content"), [".mdx", ".md"]),
      ...filesUnder(path.join(root, "components/marketing"), [".tsx", ".ts"]),
      ...filesUnder(path.join(root, "components/docs"), [".tsx", ".ts"]),
      ...filesUnder(path.join(root, "lib/marketing"), [".ts"]),
      ...filesUnder(path.join(root, "lib/docs"), [".ts", ".tsx"]),
      ...filesUnder(path.join(root, "app/(marketing)"), [".tsx", ".ts"]),
      path.join(root, "app/opengraph-image.tsx"),
      path.join(root, "app/globals.css"),
    ];
    expect(sources.length).toBeGreaterThan(20);
    for (const f of sources) expect(readFileSync(f, "utf8"), f).not.toMatch(FORBIDDEN);

    // The production build's prerendered pages, when a build exists (CI runs tests before building).
    const built = filesUnder(path.join(root, ".next/server/app"), [".html", ".rsc", ".body"]);
    for (const f of built) expect(readFileSync(f, "utf8"), f).not.toMatch(FORBIDDEN);
  });
});
