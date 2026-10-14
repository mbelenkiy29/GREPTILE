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
