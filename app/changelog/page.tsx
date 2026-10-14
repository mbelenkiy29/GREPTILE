import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const metadata: Metadata = { title: "Changelog", description: "What changed in OpenReview." };
export default async function Changelog() {
  const source = await fs.readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
  return <div className="docs-layout single">
    <header className="site-header"><Link className="brand" href="/"><span className="mark">⌘</span> OpenReview</Link><nav aria-label="Site"><Link href="/docs/quickstart">Docs</Link><Link href="/changelog" aria-current="page">Changelog</Link><Link href="/dashboard">Dashboard</Link></nav></header>
    <main className="docs-content review-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{source}</Markdown></main>
  </div>;
}
