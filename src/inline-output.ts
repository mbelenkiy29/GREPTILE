import { findingTags, priorityOf, tagLabels } from "./priority";
import type { Finding, SourceFile } from "./engine/types";

// `openreview review --inline`: each finding as a `file:line` block with a few lines of head context
// (flagged lines marked with ">"), its priority and tags, the explanation and the suggested fix.
export function inlineReport(findings: Finding[], files: Pick<SourceFile, "path" | "content">[], context = 2) {
  if (!findings.length) return "No findings.";
  const blocks = findings.map((f) => {
    const header = `${f.filePath}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ""}  [${[`${priorityOf(f.severity)} ${f.severity}`, ...findingTags(f).map((t) => tagLabels[t])].join(", ")}] ${f.title}`;
    const lines = files.find((s) => s.path === f.filePath)?.content.split("\n");
    const excerpt: string[] = [];
    if (lines) {
      const from = Math.max(1, f.startLine - context), to = Math.min(lines.length, f.endLine + context);
      const width = String(to).length;
      for (let n = from; n <= to; n++) excerpt.push(`${n >= f.startLine && n <= f.endLine ? ">" : " "} ${String(n).padStart(width)} | ${lines[n - 1]}`.trimEnd());
    }
    return [header, ...excerpt, ...f.description.split("\n").map((l) => `  ${l}`.trimEnd()), `  Fix: ${f.suggestedFix}`].join("\n");
  });
  return `${blocks.join("\n\n")}\n\n${findings.length} finding${findings.length === 1 ? "" : "s"}.`;
}
