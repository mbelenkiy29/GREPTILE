import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SiteFooter, SiteHeader } from "../site-chrome";

export const metadata: Metadata = { title: "Changelog", description: "What changed in OpenReview." };
export default async function Changelog() {
  const source = await fs.readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
  return <div className="docs-layout single">
    <SiteHeader current="changelog" />
    <main className="docs-content review-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{source}</Markdown></main>
    <SiteFooter />
  </div>;
}
