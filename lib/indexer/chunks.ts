/**
 * File chunks for full-text and vector retrieval (R6.3). Code is cut into line windows aligned to top-level symbol
 * boundaries, docs into sections by heading, config into windows aligned to top-level keys. Every chunk is at most
 * `MAX_CHUNK_LINES` lines and `MAX_CHUNK_BYTES` bytes.
 */

export type ChunkKind = "code" | "doc" | "config";

export interface Chunk {
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  content: string;
}

export const MAX_CHUNK_LINES = 120;
export const MAX_CHUNK_BYTES = 8192;
/** Don't cut at a preferred boundary that would leave a chunk shorter than this. */
const MIN_CHUNK_LINES = 12;

/** Lines of `text` without the empty string that follows a trailing newline. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Largest element of sorted `xs` that is <= `max`, or undefined. */
function lastAtMost(xs: readonly number[], max: number): number | undefined {
  let lo = 0;
  let hi = xs.length - 1;
  let found: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= max) {
      found = xs[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Windows over `lines[from-1 .. to-1]` (1-based, inclusive), preferring to start a new window at one of `breaks`
 * (sorted 1-based line numbers).
 */
export function windowLines(
  lines: readonly string[],
  from: number,
  to: number,
  breaks: readonly number[] = [],
  maxLines = MAX_CHUNK_LINES,
  maxBytes = MAX_CHUNK_BYTES,
): { startLine: number; endLine: number }[] {
  // prefix[i] = bytes of lines[0 .. i-1] including their newlines.
  const prefix = new Array<number>(to + 1);
  prefix[from - 1] = 0;
  for (let i = from; i <= to; i++) prefix[i] = prefix[i - 1]! + byteLength(lines[i - 1]!) + 1;
  const bytes = (s: number, e: number) => prefix[e]! - prefix[s - 1]!;

  const out: { startLine: number; endLine: number }[] = [];
  let start = from;
  while (start <= to) {
    let end = Math.min(to, start + maxLines - 1);
    if (bytes(start, end) > maxBytes) {
      // Binary search the last end that fits; a single oversized line still forms its own chunk.
      let lo = start;
      let hi = end;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bytes(start, mid) <= maxBytes) lo = mid;
        else hi = mid - 1;
      }
      end = lo;
    }
    if (end < to) {
      const b = lastAtMost(breaks, end + 1);
      if (b !== undefined && b - start >= MIN_CHUNK_LINES && b > start) end = b - 1;
    }
    out.push({ startLine: start, endLine: end });
    start = end + 1;
  }
  return out;
}

function materialize(lines: readonly string[], spans: { startLine: number; endLine: number }[], kind: ChunkKind): Chunk[] {
  const chunks: Chunk[] = [];
  for (const s of spans) {
    let content = lines.slice(s.startLine - 1, s.endLine).join("\n");
    if (!content.trim()) continue;
    if (byteLength(content) > MAX_CHUNK_BYTES) content = Buffer.from(content, "utf8").subarray(0, MAX_CHUNK_BYTES).toString("utf8");
    chunks.push({ startLine: s.startLine, endLine: s.endLine, kind, content });
  }
  return chunks;
}

/** Code chunks aligned to the given symbol spans (top-level symbols make the best boundaries). */
export function chunkCode(lines: readonly string[], symbolSpans: readonly { startLine: number; endLine: number }[]): Chunk[] {
  if (lines.length === 0) return [];
  const breaks = new Set<number>();
  for (const s of symbolSpans) {
    breaks.add(s.startLine);
    breaks.add(s.endLine + 1);
  }
  const sorted = [...breaks].filter((b) => b > 1 && b <= lines.length).sort((a, b) => a - b);
  return materialize(lines, windowLines(lines, 1, lines.length, sorted), "code");
}

/** Markdown / reStructuredText / AsciiDoc sections by heading (outside fenced code), each windowed. */
export function chunkDoc(lines: readonly string[], language: string): Chunk[] {
  if (lines.length === 0) return [];
  const starts: number[] = [1];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null || i === 0) continue;
    const atx = /^#{1,6}\s+\S/.test(line) && language !== "rst";
    const adoc = language === "asciidoc" && /^={1,6}\s+\S/.test(line);
    const underline = language === "rst" && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(line) && (lines[i - 1] ?? "").trim() !== "";
    if (atx || adoc) starts.push(i + 1);
    else if (underline && i >= 1) starts.push(i); // the heading text is the previous line
  }
  const unique = [...new Set(starts)].sort((a, b) => a - b);
  const spans: { startLine: number; endLine: number }[] = [];
  unique.forEach((s, idx) => {
    const end = (unique[idx + 1] ?? lines.length + 1) - 1;
    if (end >= s) spans.push(...windowLines(lines, s, end, blankLineBreaks(lines, s, end)));
  });
  return materialize(lines, spans, "doc");
}

function blankLineBreaks(lines: readonly string[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) if (lines[i - 1]!.trim() === "" && lines[i]!.trim() !== "") out.push(i + 1);
  return out;
}

/** Config windows, preferring to break before unindented keys (YAML/TOML/INI sections). */
export function chunkConfig(lines: readonly string[]): Chunk[] {
  if (lines.length === 0) return [];
  const breaks: number[] = [];
  for (let i = 1; i < lines.length; i++) if (/^[\w"'[.-]/.test(lines[i]!)) breaks.push(i + 1);
  return materialize(lines, windowLines(lines, 1, lines.length, breaks), "config");
}
