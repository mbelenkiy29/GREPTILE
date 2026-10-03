import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/CopyButton";

/** A fenced code block in the docs: language label, copy button, horizontal scroll. Content is rendered as text. */
export function DocCode({ code, lang }: { code: string; lang: string }) {
  return (
    <figure className="doc-code">
      <figcaption className="doc-code-head">
        <span>{lang || "text"}</span>
        <CopyButton value={code} compact label="Copy code" />
      </figcaption>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** Internal links use client-side navigation; external links open in place with a safe referrer policy. */
export function DocLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith("/") || href.startsWith("#")) {
    return href.startsWith("#") ? <a href={href}>{children}</a> : <Link href={href}>{children}</Link>;
  }
  return (
    <a href={href} rel="noreferrer">
      {children}
    </a>
  );
}

/** Tables scroll sideways inside their own box instead of widening the page. */
export function DocTable({ children }: { children: ReactNode }) {
  return (
    <div className="doc-table" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  );
}

const CALLOUT_LABEL = { note: "Note", tip: "Tip", warning: "Warning" } as const;

/** A highlighted aside in docs pages: `<Callout tone="warning">…</Callout>`. */
export function Callout({ tone = "note", title, children }: { tone?: keyof typeof CALLOUT_LABEL; title?: string; children: ReactNode }) {
  return (
    <aside className="doc-callout" data-tone={tone}>
      <p className="doc-callout-title">{title ?? CALLOUT_LABEL[tone]}</p>
      <div className="doc-callout-body">{children}</div>
    </aside>
  );
}
