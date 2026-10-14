import type { CodeIndex } from "./indexer";
import type { ChangedFile } from "./types";

export type ContextItem = {
  provenance?: { repository: string; revision: string; sourceUrl: string };
  path: string;
  content: string;
  startLine: number;
  reason: string;
  score: number;
};
export function retrieve(
  index: CodeIndex,
  diff: ChangedFile[],
  tokenBudget: number,
  hints: { path: string; reason: string; score: number }[] = [],
): ContextItem[] {
  const changed = new Set(
    diff.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]),
  );
  const identifiers = new Set(
    diff.flatMap((f) => f.patch.match(/[A-Za-z_]\w{3,}/g) ?? []),
  );
  const related = new Set<string>();
  for (const edge of index.relationships)
    if (changed.has(edge.from) || changed.has(edge.to)) {
      related.add(edge.from);
      related.add(edge.to);
    }
  const symbolPaths = new Set(
    index.symbols.filter((s) => identifiers.has(s.name)).map((s) => s.path),
  );
  const hintMap = new Map(hints.map((h) => [h.path, h]));
  const ranked = index.files
    .map((file) => {
      let score = hintMap.get(file.path)?.score ?? 0;
      const reasons: string[] = hintMap.has(file.path)
        ? [hintMap.get(file.path)!.reason]
        : [];
      if (changed.has(file.path)) {
        score += 100;
        reasons.push("changed file");
      }
      if (related.has(file.path)) {
        score += 60;
        reasons.push("dependency/caller/test");
      }
      if (symbolPaths.has(file.path)) {
        score += 45;
        reasons.push("exact symbol");
      }
      if (
        /(README|AGENTS|CONTRIBUTING|schema|package\.json|tsconfig|\.github\/workflows)/i.test(
          file.path,
        )
      ) {
        score += 10;
        reasons.push("repository conventions/configuration");
      }
      const terms = [...identifiers].filter((t) =>
        file.content.includes(t),
      ).length;
      score += Math.min(15, terms);
      if (terms) reasons.push("text match");
      return { ...file, score, reason: reasons.join(", ") };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const result: ContextItem[] = [];
  let remaining = tokenBudget * 4;
  for (const file of ranked) {
    if (remaining < 200) break;
    const lines = file.content.split("\n");
    const max = Math.min(remaining, changed.has(file.path) ? 16000 : 8000);
    let start = 0;
    if (file.content.length > max) {
      const symbol = index.symbols.find(
        (s) => s.path === file.path && identifiers.has(s.name),
      );
      start = symbol ? Math.max(0, symbol.line - 8) : 0;
    }
    let content = "";
    for (let i = start; i < lines.length; i++) {
      if (content.length + lines[i].length + 1 > max) break;
      content += lines[i] + "\n";
    }
    if (!content) continue;
    remaining -= content.length;
    result.push({
      provenance: file.provenance,
      path: file.path,
      content,
      startLine: start + 1,
      reason: file.reason,
      score: file.score,
    });
  }
  return result;
}
