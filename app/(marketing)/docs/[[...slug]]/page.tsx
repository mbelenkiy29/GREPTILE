import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DocsSearch } from "@/components/docs/DocsSearch";
import { loadDoc, navTitle } from "@/lib/docs/content";
import { DOCS_NAV, DOC_SLUGS, docHref, neighbours, slugFromParams } from "@/lib/docs/nav";
import { renderDoc } from "@/lib/docs/render";

// Every page is generated at build time from content/docs (R5.3); unknown paths are 404s.
export const dynamic = "force-static";
export const dynamicParams = false;

type Params = { slug?: string[] };

export function generateStaticParams(): Params[] {
  return DOC_SLUGS.map((slug) => ({ slug: slug === "index" ? [] : [slug] }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const slug = slugFromParams((await params).slug);
  if (!slug) return {};
  const page = loadDoc(slug);
  return {
    title: slug === "index" ? "Documentation" : `${page.title} · Docs`,
    description: page.description,
    alternates: { canonical: docHref(slug) },
    openGraph: { title: `${page.title} · OpenReview docs`, description: page.description, type: "article" },
  };
}

function Sidebar({ current }: { current: string }) {
  return (
    <nav className="docs-nav" aria-label="Documentation">
      {DOCS_NAV.map((section) => (
        <div key={section.title} className="docs-nav-group">
          <p className="eyebrow">{section.title}</p>
          <ul>
            {section.slugs.map((slug) => (
              <li key={slug}>
                <Link href={docHref(slug)} aria-current={slug === current ? "page" : undefined}>
                  {navTitle(slug)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const slug = slugFromParams((await params).slug);
  if (!slug) notFound();
  const page = loadDoc(slug);
  const { content, toc } = await renderDoc(page);
  const { prev, next } = neighbours(slug);
  return (
    <div className="docs">
      <aside className="docs-sidebar">
        <DocsSearch />
        <details className="docs-nav-mobile">
          <summary>All pages</summary>
          <Sidebar current={slug} />
        </details>
        <div className="docs-nav-desktop">
          <Sidebar current={slug} />
        </div>
      </aside>
      <article className="docs-article" aria-labelledby="doc-title" data-doc={slug}>
        <header className="docs-article-head">
          <p className="eyebrow">{DOCS_NAV.find((s) => s.slugs.includes(slug))?.title}</p>
          <h1 id="doc-title">{page.title}</h1>
          <p className="docs-lede">{page.description}</p>
        </header>
        {content}
        <nav className="docs-pager" aria-label="Previous and next page">
          {prev ? (
            <Link href={docHref(prev)} rel="prev" className="docs-pager-link">
              <span className="dim">Previous</span>
              <span>{navTitle(prev)}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={docHref(next)} rel="next" className="docs-pager-link docs-pager-next">
              <span className="dim">Next</span>
              <span>{navTitle(next)}</span>
            </Link>
          )}
        </nav>
      </article>
      {toc.length > 0 && (
        <nav className="docs-toc" aria-label="On this page">
          <p className="eyebrow">On this page</p>
          <ul>
            {toc.map((t) => (
              <li key={t.id} data-depth={t.depth}>
                <a href={`#${t.id}`}>{t.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
