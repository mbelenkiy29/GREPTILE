// Unified-diff parsing for the review diff viewer: numbered lines per hunk, and findings placed
// after the new-side line they anchor to (findings outside the shown hunks are listed separately).
export type DiffLine = { kind: "add" | "del" | "ctx"; old?: number; new?: number; text: string };
export type DiffHunk = { header: string; lines: DiffLine[] };
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null, oldLine = 0, newLine = 0;
  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (header) { current = { header: raw, lines: [] }; hunks.push(current); oldLine = Number(header[1]); newLine = Number(header[2]); continue; }
    if (!current || raw.startsWith("\\ No newline")) continue;
    if (raw.startsWith("+")) current.lines.push({ kind: "add", new: newLine++, text: raw.slice(1) });
    else if (raw.startsWith("-")) current.lines.push({ kind: "del", old: oldLine++, text: raw.slice(1) });
    else current.lines.push({ kind: "ctx", old: oldLine++, new: newLine++, text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return hunks;
}
export function placeFindings<F extends { startLine: number }>(hunks: DiffHunk[], findings: F[]) {
  const shown = new Set(hunks.flatMap((h) => h.lines.map((l) => l.new).filter((n): n is number => n !== undefined)));
  const at = new Map<number, F[]>(), outside: F[] = [];
  for (const f of findings) { if (shown.has(f.startLine)) at.set(f.startLine, [...(at.get(f.startLine) ?? []), f]); else outside.push(f); }
  return { at, outside };
}
