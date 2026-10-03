import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer for model- and PR-authored text (H7: untrusted). It builds React elements only —
 * raw HTML in the source is shown as text, never injected — and links are kept only for http(s) URLs.
 * Supports headings, paragraphs, bullet and numbered lists, fenced code, blockquotes, `code`, **bold**, *italic*,
 * and [links](https://…).
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const re = bullet.test(line) ? bullet : numbered;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i++]!;
        if (re.test(l)) items.push(l.replace(re, ""));
        else items[items.length - 1] += ` ${l.trim()}`;
      }
      blocks.push({ kind: re === bullet ? "ul" : "ol", items });
      continue;
    }
    // The first line always belongs to the paragraph, so every iteration consumes input.
    const para: string[] = [lines[i++]!.trim()];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    blocks.push({ kind: "para", text: para.join(" ") });
  }
  return blocks;
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**") || tok.startsWith("__")) out.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>);
    else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = safeHref(link[2]!);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer nofollow">
            {renderInline(link[1]!, key)}
          </a>
        ) : (
          <span key={key}>{link[1]}</span>
        ),
      );
    } else out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, headingOffset = 2 }: { source: string; headingOffset?: number }) {
  const blocks = parseBlocks(source);
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "heading": {
            const level = Math.min(6, b.level + headingOffset);
            const H = `h${level}` as "h3";
            return <H key={key}>{renderInline(b.text, key)}</H>;
          }
          case "para":
            return <p key={key}>{renderInline(b.text, key)}</p>;
          case "quote":
            return <blockquote key={key}>{renderInline(b.text, key)}</blockquote>;
          case "code":
            return (
              <pre key={key} data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "ul":
          case "ol": {
            const L = b.kind;
            return (
              <L key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </L>
            );
          }
        }
      })}
    </div>
  );
}
