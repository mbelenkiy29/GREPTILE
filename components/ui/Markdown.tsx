import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer for model- and PR-authored text (H7: untrusted). It builds React elements only —
 * raw HTML in the source is shown as text, never injected — and links are kept only for http(s) URLs.
 * Supports headings, paragraphs, bullet and numbered lists, fenced code (3+ backticks or tildes, so a fence can hold
 * another), blockquotes, GFM tables, `code`, **bold**, *italic*, and [links](https://…). The few HTML constructs git
 * hosts render in review comments are recognised as whole lines and mapped to elements: `<details>` with an optional
 * `<summary>` (a native collapsible) and a `<sub>…</sub>` line (small text). Any other HTML stays text.
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "details"; summary: string; blocks: Block[] }
  | { kind: "small"; text: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const SUB_LINE = /^\s*<sub>(.*)<\/sub>\s*$/i;
const DETAILS_OPEN = /^\s*<details(\s+open)?\s*>/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;

function isFenceClose(line: string, open: string): boolean {
  const t = line.trim();
  return (
    t.length >= open.length &&
    t[0] === open[0] &&
    [...t].every((c) => c === open[0])
  );
}

function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isTableStart(lines: string[], i: number): boolean {
  return (
    /^\s*\|/.test(lines[i] ?? "") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")
  );
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i]!, fence[1]!))
        body.push(lines[i++]!);
      i++;
      blocks.push({
        kind: "code",
        lang: fence[2] ?? "",
        text: body.join("\n"),
      });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (DETAILS_OPEN.test(line)) {
      // Collect up to the matching </details> (nested ones and fenced code included), then parse the inside.
      let rest = line.replace(DETAILS_OPEN, "");
      const inner: string[] = [];
      let depth = 1;
      let fenceOpen: string | null = null;
      i++;
      for (;;) {
        if (rest.trim()) inner.push(rest);
        if (i >= lines.length) break;
        const l = lines[i++]!;
        rest = "";
        if (fenceOpen) {
          if (isFenceClose(l, fenceOpen)) fenceOpen = null;
          inner.push(l);
          continue;
        }
        const f = FENCE.exec(l);
        if (f) fenceOpen = f[1]!;
        else if (DETAILS_OPEN.test(l)) depth++;
        else if (DETAILS_CLOSE.test(l) && --depth === 0) break;
        inner.push(l);
      }
      let summary = "Details";
      const first = inner.findIndex((l) => l.trim());
      const sm =
        first >= 0
          ? /^\s*<summary>(.*?)<\/summary>\s*(.*)$/i.exec(inner[first]!)
          : null;
      if (sm) {
        summary = sm[1]!.trim() || summary;
        inner[first] = sm[2]!;
      }
      blocks.push({
        kind: "details",
        summary,
        blocks: parseBlocks(inner.join("\n")),
      });
      continue;
    }
    const sub = SUB_LINE.exec(line);
    if (sub) {
      blocks.push({ kind: "small", text: sub[1]!.trim() });
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!))
        rows.push(tableCells(lines[i++]!));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const re = bullet.test(line) ? bullet : numbered;
      const items: string[] = [];
      while (
        i < lines.length &&
        (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))
      ) {
        const l = lines[i++]!;
        if (re.test(l)) items.push(l.replace(re, ""));
        else items[items.length - 1] += ` ${l.trim()}`;
      }
      blocks.push({ kind: re === bullet ? "ul" : "ol", items });
      continue;
    }
    // The first line always belongs to the paragraph, so every iteration consumes input.
    const para: string[] = [lines[i++]!.trim()];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(
        lines[i]!,
      ) &&
      !DETAILS_OPEN.test(lines[i]!) &&
      !SUB_LINE.test(lines[i]!) &&
      !isTableStart(lines, i)
    )
      para.push(lines[i++]!.trim());
    blocks.push({ kind: "para", text: para.join(" ") });
  }
  return blocks;
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:"
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

// Underscore emphasis only at word boundaries (as in GFM), so identifiers like MAX_PERCENT_OFF stay intact.
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|((?<!\w)__[^_]+__(?!\w))|(\*[^*\s][^*]*\*)|((?<!\w)_[^_\s][^_]*_(?!\w))|(\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (tok.startsWith("`"))
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**") || tok.startsWith("__"))
      out.push(
        <strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>,
      );
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

export function Markdown({
  source,
  headingOffset = 2,
}: {
  source: string;
  headingOffset?: number;
}) {
  return (
    <div className="prose">
      {renderBlocks(parseBlocks(source), headingOffset, "b")}
    </div>
  );
}

function renderBlocks(
  blocks: Block[],
  headingOffset: number,
  prefix: string,
): ReactNode[] {
  return blocks.map((b, i) => {
    const key = `${prefix}${i}`;
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
      case "small":
        return (
          <p key={key}>
            <small>{renderInline(b.text, key)}</small>
          </p>
        );
      case "details":
        return (
          <details key={key}>
            <summary>{renderInline(b.summary, key)}</summary>
            {renderBlocks(b.blocks, headingOffset, `${key}-`)}
          </details>
        );
      case "table":
        return (
          <div key={key} className="md-table-wrap">
            <table>
              <thead>
                <tr>
                  {b.head.map((h, j) => (
                    <th key={j}>{renderInline(h, `${key}-h${j}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {b.head.map((_, k) => (
                      <td key={k}>
                        {renderInline(r[k] ?? "", `${key}-${j}-${k}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  });
}
