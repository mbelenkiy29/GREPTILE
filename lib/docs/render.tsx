/**
 * Renders a docs page (R5.3) by compiling its MDX and Markdown segments with `@mdx-js/mdx` at build time (the docs
 * routes are statically generated). Headings get stable ids in document order, which also feed the on-page table of
 * contents; fenced code blocks get a copy button; tables scroll on small screens.
 */
import { evaluate } from "@mdx-js/mdx";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import { Callout, DocCode, DocLink, DocTable } from "@/components/docs/DocElements";
import { Slugger, type DocPage } from "./content";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface TocEntry {
  depth: 2 | 3;
  id: string;
  text: string;
}

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** Rehype plugin: gives every h2/h3 a unique id and records it for the table of contents. */
function headingIds(slugger: Slugger, toc: TocEntry[]) {
  return () => (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.type === "element" && (node.tagName === "h2" || node.tagName === "h3")) {
        const text = hastText(node).trim();
        const id = slugger.slug(text);
        node.properties = { ...(node.properties ?? {}), id };
        toc.push({ depth: node.tagName === "h2" ? 2 : 3, id, text });
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const components = {
  pre: ({ children }: ComponentProps<"pre">) => {
    const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
    const lang = /language-([\w+-]+)/.exec(child?.props.className ?? "")?.[1] ?? "";
    return <DocCode code={textOf(child ? child.props.children : children).replace(/\n$/, "")} lang={lang} />;
  },
  a: ({ href, children }: ComponentProps<"a">) => <DocLink href={href ?? "#"}>{children}</DocLink>,
  table: ({ children }: ComponentProps<"table">) => <DocTable>{children}</DocTable>,
  Callout,
};

export interface RenderedDoc {
  content: ReactElement;
  toc: TocEntry[];
}

/** Compiles and renders every segment of a page; returns the content and its table of contents. */
export async function renderDoc(page: DocPage): Promise<RenderedDoc> {
  const slugger = new Slugger();
  const toc: TocEntry[] = [];
  const parts: ReactElement[] = [];
  for (const [i, seg] of page.segments.entries()) {
    const { default: Content } = await evaluate(seg.source, {
      ...runtime,
      format: seg.format,
      remarkPlugins: [remarkGfm],
      rehypePlugins: [headingIds(slugger, toc)],
      development: false,
    });
    parts.push(<Content key={i} components={components} />);
  }
  return { content: <div className="doc-prose">{parts}</div>, toc };
}
