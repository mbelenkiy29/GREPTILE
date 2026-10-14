// Pure patch helpers (no Node APIs) shared by the web, Convex default runtime and engine.
export function changedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || text.startsWith("\\")) continue;
    if (text.startsWith("+")) {
      lines.add(line);
      line++;
    } else if (text.startsWith(" ")) line++;
  }
  return lines;
}

// New-side (RIGHT) lines visible in each hunk — added and context lines — keyed to their hunk.
export function rightSideHunks(patch: string): Map<number, number> {
  const lines = new Map<number, number>();
  let line = 0, hunk = -1;
  for (const text of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { line = Number(header[1]); hunk++; continue; }
    if (hunk < 0 || text.startsWith("\\") || text.startsWith("-")) continue;
    if (text.startsWith("+") || text.startsWith(" ")) { lines.set(line, hunk); line++; }
  }
  return lines;
}
// Multi-line review comments must stay on the RIGHT side of one hunk; otherwise comment on the
// first line only.
export function commentRange(patch: string, startLine: number, endLine: number): { start: number; end: number } {
  if (endLine <= startLine) return { start: startLine, end: startLine };
  const hunks = rightSideHunks(patch), hunk = hunks.get(startLine);
  if (hunk === undefined) return { start: startLine, end: startLine };
  for (let line = startLine; line <= endLine; line++) if (hunks.get(line) !== hunk) return { start: startLine, end: startLine };
  return { start: startLine, end: endLine };
}
