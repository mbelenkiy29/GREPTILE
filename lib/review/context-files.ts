import type { GitClient } from "@/lib/git/types";
import { globMatch } from "@/lib/rules";

export interface ContextDoc {
  path: string;
  content: string;
  truncated: boolean;
}

const MAX_FILES = 20;
const PER_FILE_CHARS = 12_000;
const TOTAL_CHARS = 40_000;
const isGlob = (p: string) => /[*?[\]{}!]/.test(p);

/**
 * Loads the docs a repo designates as always-on review context (R2.3), e.g.
 * CONTRIBUTING.md or `docs/adr/*.md`, at `ref`. Exact paths are fetched
 * directly; globs are expanded against the repository tree. Output is capped
 * per file and in total; missing entries are reported back as notices.
 */
export async function loadContextDocs(
  client: GitClient,
  repo: string,
  ref: string,
  patterns: string[],
): Promise<{ docs: ContextDoc[]; notices: string[] }> {
  if (!patterns.length) return { docs: [], notices: [] };
  const notices: string[] = [];
  const paths: string[] = [];
  const globs = patterns.filter(isGlob);
  const tree = globs.length ? await client.listTree(repo, ref) : [];
  for (const p of patterns) {
    const matched = isGlob(p) ? tree.filter((t) => globMatch([p], t)).sort() : [p.replace(/^\.?\//, "")];
    if (isGlob(p) && matched.length === 0) notices.push(`Context pattern \`${p}\` matched no files.`);
    for (const m of matched) if (!paths.includes(m)) paths.push(m);
  }

  const docs: ContextDoc[] = [];
  let total = 0;
  for (const path of paths.slice(0, MAX_FILES)) {
    const text = await client.getFileContent(repo, path, ref);
    if (text === null) {
      notices.push(`Context file \`${path}\` was not found.`);
      continue;
    }
    const room = Math.min(PER_FILE_CHARS, TOTAL_CHARS - total);
    if (room <= 0) {
      notices.push(`Context budget reached; \`${path}\` and later files were skipped.`);
      break;
    }
    const content = text.slice(0, room);
    total += content.length;
    docs.push({ path, content, truncated: content.length < text.length });
  }
  if (paths.length > MAX_FILES) notices.push(`Only the first ${MAX_FILES} context files are included.`);
  return { docs, notices };
}

export function renderContextSection(docs: ContextDoc[]): string {
  if (!docs.length) return "";
  return [
    "## Project guidelines (context files)",
    "These documents are the team's own conventions and decisions. Hold the change to them, and when a finding relies on",
    "one, name the document path in the finding body.",
    ...docs.map((d) => `### ${d.path}${d.truncated ? " (truncated)" : ""}\n${d.content}`),
  ].join("\n\n");
}
