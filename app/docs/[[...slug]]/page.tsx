import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { docBySlug, docPages, resolveDocLink } from "../../../src/docs-manifest";

// Public documentation, rendered at build time from Markdown in docs/.
export const dynamicParams = false;
export function generateStaticParams() { return [{ slug: [] }, ...docPages.map((d) => ({ slug: [d.slug] }))]; }
const pageFor = (slug: string[] = []) => (slug.length === 0 ? docPages[0] : slug.length === 1 ? docBySlug(slug[0]) : undefined);
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }): Promise<Metadata> {
  const page = pageFor((await params).slug);
  return page ? { title: page.title, description: page.description, alternates: { canonical: `/docs/${page.slug}` } } : {};
}
export default async function DocsPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const page = pageFor((await params).slug);
  if (!page) notFound();
  const source = await fs.readFile(path.join(process.cwd(), "docs", page.file), "utf8");
  const sections = [...new Set(docPages.map((d) => d.section))];
  return <div className="docs-layout">
    <header className="site-header"><Link className="brand" href="/"><span className="mark">⌘</span> OpenReview</Link><nav aria-label="Site"><Link href="/docs/quickstart">Docs</Link><Link href="/changelog">Changelog</Link><Link href="/dashboard">Dashboard</Link></nav></header>
    <aside className="docs-nav" aria-label="Documentation">{sections.map((s) => <div key={s}><h2>{s}</h2><ul>{docPages.filter((d) => d.section === s).map((d) => <li key={d.slug}><Link href={`/docs/${d.slug}`} aria-current={d.slug === page.slug ? "page" : undefined}>{d.title}</Link></li>)}</ul></div>)}</aside>
    <main className="docs-content review-markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} components={{
        a: ({ href, children }) => { const link = resolveDocLink(page.file, href ?? ""); return link.kind === "external" ? <a href={link.url} target="_blank" rel="noopener noreferrer">{children}</a> : link.kind === "text" || !link.url ? <span>{children}</span> : <Link href={link.url}>{children}</Link>; },
        table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
      }}>{source}</Markdown>
    </main>
  </div>;
}
