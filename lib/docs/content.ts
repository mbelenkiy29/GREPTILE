/**
 * Documentation content (R5.3): MDX pages in `content/docs/<slug>.mdx` with a small frontmatter block (`title`,
 * `description`). Pages can pull in material that lives elsewhere so it is written once:
 *
 * - `{/* @include path/to/file.md *\/}` inserts a repository Markdown file (headings shifted one level down, its own
 *   title dropped, links to other repository files rewritten to docs pages or to the source repository);
 * - `{/* @generated config-reference | env-reference | api-reference *\/}` inserts a generated reference
 *   (`lib/docs/generated.ts`).
 *
 * Both directives are MDX comments, so the page source stays valid MDX on its own.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { siteEnv } from "@/lib/env";
import { apiReferenceMarkdown, configReferenceMarkdown, envReferenceMarkdown, modesReferenceMarkdown, repoRoot } from "./generated";
import { DOC_SLUGS, docHref } from "./nav";

export const CONTENT_DIR = "content/docs";

export type SegmentFormat = "mdx" | "md";

export interface DocSegment {
  format: SegmentFormat;
  source: string;
}

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  segments: DocSegment[];
}

const frontmatterSchema = z.object({ title: z.string().min(1), description: z.string().min(1), navTitle: z.string().min(1).optional() }).strict();
export type DocFrontmatter = z.infer<typeof frontmatterSchema>;

const GENERATORS: Record<string, () => string> = {
  "config-reference": configReferenceMarkdown,
  "env-reference": () => envReferenceMarkdown(),
  "api-reference": apiReferenceMarkdown,
  // Defaults, not this build machine's environment: the page documents what an unconfigured server does.
  "modes-reference": () => modesReferenceMarkdown({}),
};

/** Repository Markdown files that have a docs page of their own: links to them stay on the site. */
export const INCLUDED_FILE_PAGES: Record<string, string> = {
  "packages/cli/README.md": "cli",
  "docs/mcp.md": "mcp",
  "docs/gitlab.md": "gitlab",
  "docs/bitbucket.md": "bitbucket",
  "SECURITY.md": "security",
};

const DIRECTIVE = /^\{\/\*\s*@(include|generated)\s+(\S+)\s*\*\/\}\s*$/;

/** Slugs of every `.mdx` file in the content directory. */
export function contentSlugs(root = repoRoot()): string[] {
  const dir = path.join(root, CONTENT_DIR);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mdx"))
    .map((f) => f.slice(0, -".mdx".length))
    .sort();
}

/** Splits `---` frontmatter from the body and validates it. */
export function parseFrontmatter(text: string, file = "page"): { data: DocFrontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n?/g, "\n"));
  if (!m) throw new Error(`${file}: missing frontmatter (title, description)`);
  const parsed = frontmatterSchema.safeParse(parseYaml(m[1]!));
  if (!parsed.success) throw new Error(`${file}: invalid frontmatter: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return { data: parsed.data, body: text.replace(/\r\n?/g, "\n").slice(m[0].length) };
}

/** Lines outside fenced code blocks get `fn`; fenced lines are kept as they are. */
function mapOutsideFences(markdown: string, fn: (line: string) => string | null): string {
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (f && line.trim().startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push(line);
      continue;
    }
    const mapped = fn(line);
    if (mapped !== null) out.push(mapped);
  }
  return out.join("\n");
}

/** Where a relative link in an included repository file should point. */
export function resolveIncludedLink(fromFile: string, href: string, sourceUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const [target, hash] = href.split("#") as [string, string | undefined];
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  const page = INCLUDED_FILE_PAGES[resolved];
  if (page) return `${docHref(page)}${hash ? `#${hash}` : ""}`;
  const base = sourceUrl.replace(/\/+$/, "");
  return `${base}/blob/main/${resolved}${hash ? `#${hash}` : ""}`;
}

/** A repository Markdown file prepared for inclusion in a docs page. */
export function prepareInclude(file: string, text: string, sourceUrl: string): string {
  let droppedTitle = false;
  const body = mapOutsideFences(text.replace(/\r\n?/g, "\n"), (line) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1]!.length === 1 && !droppedTitle) {
        droppedTitle = true;
        return null;
      }
      return `${"#".repeat(Math.min(6, h[1]!.length + 1))} ${h[2]}`;
    }
    return line.replace(/\]\(([^)\s]+)\)/g, (_m, href: string) => `](${resolveIncludedLink(file, href, sourceUrl)})`);
  });
  return body.trim();
}

/** Splits a page body into MDX segments and included/generated Markdown segments. */
export function segmentsOf(body: string, root = repoRoot(), sourceUrl = siteEnv().SOURCE_CODE_URL): DocSegment[] {
  const segments: DocSegment[] = [];
  let buf: string[] = [];
  const flush = () => {
    const source = buf.join("\n").trim();
    if (source) segments.push({ format: "mdx", source });
    buf = [];
  };
  for (const line of body.split("\n")) {
    const d = DIRECTIVE.exec(line.trim());
    if (!d) {
      buf.push(line);
      continue;
    }
    flush();
    const [, kind, arg] = d as unknown as [string, "include" | "generated", string];
    if (kind === "include") {
      const file = path.posix.normalize(arg);
      if (file.startsWith("..") || path.isAbsolute(file)) throw new Error(`@include must name a file inside the repository: ${arg}`);
      const abs = path.join(root, file);
      if (!existsSync(abs)) throw new Error(`@include: ${file} does not exist`);
      segments.push({ format: "md", source: prepareInclude(file, readFileSync(abs, "utf8"), sourceUrl) });
    } else {
      const gen = GENERATORS[arg];
      if (!gen) throw new Error(`@generated: unknown generator ${arg}`);
      segments.push({ format: "md", source: gen() });
    }
  }
  flush();
  return segments;
}

const cache = new Map<string, DocPage>();

/** Loads one docs page (cached per process; content is fixed at build time). */
export function loadDoc(slug: string, root = repoRoot()): DocPage {
  const key = `${root}\0${slug}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!DOC_SLUGS.includes(slug)) throw new Error(`unknown docs page: ${slug}`);
  const file = path.join(root, CONTENT_DIR, `${slug}.mdx`);
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"), file);
  const page: DocPage = { slug, title: data.title, description: data.description, segments: segmentsOf(body, root) };
  cache.set(key, page);
  return page;
}

/** Short sidebar title of a page (frontmatter `navTitle`, else `title`). */
export function navTitle(slug: string, root = repoRoot()): string {
  const file = path.join(root, CONTENT_DIR, `${slug}.mdx`);
  const { data } = parseFrontmatter(readFileSync(file, "utf8"), file);
  return data.navTitle ?? data.title;
}

/** Heading slug: lower-case words joined by dashes (GitHub style). */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

/** Assigns unique heading ids in document order. */
export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string): string {
    const base = slugify(text);
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }
}

/** Inline Markdown/MDX reduced to text: code spans, emphasis, links, JSX tags and expressions removed. */
export function plainInline(text: string): string {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\\([|*_`[\]])/g, "$1")
    .trim();
}

export interface DocHeading {
  depth: 2 | 3;
  text: string;
}

/** The `##` and `###` headings of a page in order (fenced code ignored). */
export function headingsOf(page: DocPage): DocHeading[] {
  const out: DocHeading[] = [];
  for (const seg of page.segments) {
    mapOutsideFences(seg.source, (line) => {
      const h = /^(#{2,3})\s+(.*)$/.exec(line);
      if (h) out.push({ depth: h[1]!.length as 2 | 3, text: plainInline(h[2]!) });
      return line;
    });
  }
  return out;
}

/** The text of a page for search: prose, headings, table cells, and code. */
export function plainText(page: DocPage): string {
  return page.segments
    .map((s) =>
      s.source
        .split("\n")
        .filter((l) => !/^\s*(import|export)\s/.test(l) && !/^\s*\|?\s*-{3,}/.test(l) && !/^\s*```/.test(l))
        .map((l) => plainInline(l.replace(/^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+/, "").replace(/\|/g, " ")))
        .join(" "),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SearchEntry {
  slug: string;
  href: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
}

/** Most characters of page text kept per entry, so the index stays small. */
export const SEARCH_TEXT_LIMIT = 6000;

/** The client-side search index, built at build time from every page. */
export function buildSearchIndex(root = repoRoot()): SearchEntry[] {
  return DOC_SLUGS.map((slug) => {
    const page = loadDoc(slug, root);
    return {
      slug,
      href: docHref(slug),
      title: page.title,
      description: page.description,
      headings: headingsOf(page).map((h) => h.text),
      text: plainText(page).slice(0, SEARCH_TEXT_LIMIT),
    };
  });
}
