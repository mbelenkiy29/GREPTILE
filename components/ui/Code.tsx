import { CopyButton } from "./CopyButton";

/** CSS-only soft-wrap toggle: `.code:has(.wrap-toggle input:checked)` switches lines to pre-wrap. */
function WrapToggle({ id }: { id: string }) {
  return (
    <label className="wrap-toggle" htmlFor={id}>
      <input type="checkbox" id={id} />
      Wrap
    </label>
  );
}

/** A stable id for a wrap toggle, derived from the content (pass `id` when the same snippet repeats on a page). */
function contentId(prefix: string, text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

/**
 * Source code with line numbers (starting at `startLine`), optional highlighted lines, a wrap toggle, and copy.
 * Content is rendered as text (never as HTML).
 */
export function CodeBlock({
  code,
  startLine = 1,
  highlight = [],
  title,
  id,
  copy = true,
}: {
  code: string;
  startLine?: number;
  highlight?: number[];
  title?: string;
  id?: string;
  copy?: boolean;
}) {
  const lines = code.replace(/\n$/, "").split("\n");
  const marked = new Set(highlight);
  const wrapId = id ?? contentId("wrap", `${startLine}:${title ?? ""}:${code}`);
  return (
    <figure className="code" style={{ margin: 0 }}>
      <figcaption className="code-head">
        <span className="truncate">{title ?? ""}</span>
        <span className="code-head-tools">
          <WrapToggle id={wrapId} />
          {copy && <CopyButton value={code} compact label="Copy code" />}
        </span>
      </figcaption>
      <div className="code-scroll">
        <table>
          <tbody>
            {lines.map((line, i) => {
              const n = startLine + i;
              return (
                <tr key={i} className={marked.has(n) ? "hl" : undefined}>
                  <td className="ln">{n}</td>
                  <td className="src">{line || " "}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Parses a unified diff (one file's hunks) into lines with old/new line numbers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of diff.replace(/\n$/, "").split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newN++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldLine: oldN++, newLine: null });
    } else if (raw.startsWith("\\")) {
      out.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
    } else {
      out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldLine: oldN++, newLine: newN++ });
    }
  }
  return out;
}

/** A unified diff with old/new line numbers, added/removed highlighting, a wrap toggle, and horizontal scroll. */
export function DiffView({ diff, title, id }: { diff: string; title?: string; id?: string }) {
  const lines = parseUnifiedDiff(diff);
  const wrapId = id ?? contentId("diffwrap", `${title ?? ""}:${diff}`);
  return (
    <figure className="code" style={{ margin: 0 }}>
      <figcaption className="code-head">
        <span className="truncate">{title ?? ""}</span>
        <span className="code-head-tools">
          <WrapToggle id={wrapId} />
          <CopyButton value={diff} compact label="Copy diff" />
        </span>
      </figcaption>
      <div className="code-scroll">
        <table>
          <tbody>
            {lines.map((l, i) =>
              l.kind === "hunk" ? (
                <tr key={i} className="hunk">
                  <td className="ln" />
                  <td className="ln" />
                  <td className="mark" />
                  <td className="src">{l.text}</td>
                </tr>
              ) : (
                <tr key={i} className={l.kind === "ctx" ? undefined : l.kind}>
                  <td className="ln">{l.oldLine ?? ""}</td>
                  <td className="ln">{l.newLine ?? ""}</td>
                  <td className="mark" aria-hidden="true">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                  </td>
                  <td className="src">
                    {l.kind !== "ctx" && <span className="sr-only">{l.kind === "add" ? "Added: " : "Removed: "}</span>}
                    {l.text || " "}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
