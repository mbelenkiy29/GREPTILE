import { createHash } from "node:crypto";
import type { Candidate, ChangedFile } from "./types";

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

export function parseDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const target = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1];
    const old = /^--- a\/(.+)$/m.exec(block)?.[1];
    if (!target && !old) continue;
    const index = block.indexOf("@@ ");
    files.push({
      path: target ?? old!,
      previousPath: old && target && target !== old ? old : undefined,
      status: !target ? "removed" : !old ? "added" : "modified",
      patch: index < 0 ? "" : block.slice(index),
    });
  }
  return files;
}

export function fingerprint(f: Candidate): string {
  const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return createHash("sha256")
    .update(
      [
        f.filePath,
        f.category,
        normalized(f.symbol),
        normalized(f.title),
        normalized(
          f.evidence.find((e) => e.filePath === f.filePath)?.quote ?? "",
        ),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
}

export function overlaps(a: Candidate, b: Candidate): boolean {
  if (a.filePath !== b.filePath) return false;
  if (fingerprint(a) === fingerprint(b)) return true;
  const words = (s: string) =>
    new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const x = words(a.title + " " + a.impact),
    y = words(b.title + " " + b.impact);
  const shared = [...x].filter((w) => y.has(w)).length;
  const similarity = shared / Math.max(1, new Set([...x, ...y]).size);
  const sameEvidence = a.evidence.some((left) =>
    b.evidence.some((right) => left.filePath === right.filePath && left.quote.replace(/\s/g, "") === right.quote.replace(/\s/g, "")),
  );
  return (
    (similarity > 0.55 || (sameEvidence && shared / Math.max(1, Math.min(x.size, y.size)) >= 0.4)) &&
    ((a.symbol === b.symbol && a.symbol !== "") ||
      (a.startLine <= b.endLine && b.startLine <= a.endLine))
  );
}
