import { changedLines } from "./engine/patch-lines";
import type { Candidate, ChangedFile, SourceFile } from "./engine/types";

// Committable suggestions: a finding may propose replacement text for its exact line range.
// A suggestion is published only when it applies cleanly to the reviewed head revision;
// otherwise it is dropped and the finding is kept.
export type Suggestion = NonNullable<Candidate["suggestion"]>;
export type SuggestionSyntax = "github" | "gitlab";

export function suggestionProblem(finding: Pick<Candidate, "filePath" | "startLine" | "endLine" | "suggestion">, files: SourceFile[], diff: ChangedFile[]): string | null {
  const s = finding.suggestion;
  if (!s) return null;
  if (s.startLine !== finding.startLine || s.endLine !== finding.endLine) return "Suggestion range must equal the finding's line range";
  if (s.endLine < s.startLine || s.endLine - s.startLine > 20) return "Suggestion range is invalid or longer than 21 lines";
  const changed = diff.find((d) => d.path === finding.filePath);
  if (!changed || changed.status === "removed") return "Suggestion file is not part of the change";
  const lines = changedLines(changed.patch);
  for (let line = s.startLine; line <= s.endLine; line++) if (!lines.has(line)) return "Suggestion range extends outside the changed lines";
  const source = files.find((f) => f.path === finding.filePath && !f.provenance);
  if (!source) return "Head source for the suggestion is unavailable";
  const current = source.content.split("\n").slice(s.startLine - 1, s.endLine);
  if (current.length !== s.endLine - s.startLine + 1 || current.join("\n") !== s.original.replace(/\r\n/g, "\n")) return "Suggestion no longer matches the head content of its range";
  const replacement = s.replacement.replace(/\r\n/g, "\n");
  if (replacement === current.join("\n")) return "Suggestion does not change the code";
  if (/```|~~~/.test(replacement)) return "Suggestion contains a code fence";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(replacement)) return "Suggestion contains control characters";
  return null;
}

// Fenced block for the provider. GitHub replaces the commented line range (multi-line comments
// carry start_line); GitLab counts lines relative to the commented line (-above+below).
export function suggestionBlock(s: Suggestion, syntax: SuggestionSyntax, comment: { start: number; end: number }) {
  if (syntax === "github" && (comment.start !== s.startLine || comment.end !== s.endLine)) return "";
  const header = syntax === "github" ? "```suggestion" : `\`\`\`suggestion:-${Math.max(0, comment.start - s.startLine)}+${Math.max(0, s.endLine - comment.start)}`;
  return `\n\n${header}\n${s.replacement.replace(/\r\n/g, "\n")}\n\`\`\``;
}
