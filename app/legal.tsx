import fs from "node:fs/promises";
import path from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SiteFooter, SiteHeader } from "./site-chrome";

// Privacy Policy and Terms of Service for the hosted service, read from legal/*.md at build time.
export async function LegalPage({ name }: { name: "privacy" | "terms" }) {
  const source = await fs.readFile(path.join(process.cwd(), "legal", `${name}.md`), "utf8");
  return <div className="docs-layout single">
    <SiteHeader />
    <main className="docs-content review-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{source}</Markdown></main>
    <SiteFooter />
  </div>;
}
