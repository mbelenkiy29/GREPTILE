// Existing AI-assistant rule files (CLAUDE.md, AGENTS.md, Cursor/Windsurf/Copilot/Gemini rules) imported
// as candidate review rules. Only directive statements about code become candidates; agent workflow
// (commits, branches, chatting), code blocks and persona text are dropped. Every candidate is still
// untrusted text: the server guards it again and stores it as a suggestion that an admin approves.

export const ruleFiles = ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md", "GEMINI.md", ".windsurfrules"] as const;
export const cursorRulesDirectory = ".cursor/rules";
export type RuleFileSystem = { read(path: string): Promise<string | null>; list(directory: string): Promise<string[]> };
export type ImportedRule = { title: string; instructions: string; globs: string[]; source: { path: string; line: number } };

export async function discoverRuleFiles(fs: RuleFileSystem, limit = 30): Promise<{ path: string; content: string }[]> {
  const found: { path: string; content: string }[] = [];
  const add = async (path: string) => {
    const content = await fs.read(path).catch(() => null);
    if (content !== null && content.length <= 200_000) found.push({ path, content });
  };
  for (const path of ruleFiles) await add(path);
  const cursor = (await fs.list(cursorRulesDirectory).catch(() => [])).filter((name) => /^[\w.\- ]+\.(mdc|md)$/i.test(name)).sort().slice(0, limit);
  for (const name of cursor) await add(`${cursorRulesDirectory}/${name}`);
  return found.slice(0, limit);
}

const directive = /\b(always|never|must|should|avoid|prefer|do not|don't|ensure|require|requires|keep|use|only)\b/i;
// Instructions about the agent's own workflow rather than the code under review.
const workflow = /\b(commit|commits|committing|push|pushing|branch|branches|terminal|shell|ask the user|respond|reply|answer|chat|conversation|this file|these instructions|you are|as an ai|the assistant|run `|run the)\b/i;
const strip = (text: string) => text.replace(/\*\*|__|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)/g, "").replace(/\s+/g, " ").trim();
const frontmatterGlobs = (frontmatter: string) => {
  const line = /^globs:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  const list = line.startsWith("[") ? [...line.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : line.split(",").map((g) => g.trim().replace(/^["']|["']$/g, ""));
  return list.filter((g) => g && g.length <= 200 && !g.startsWith("/") && !g.split("/").includes("..")).slice(0, 20);
};

export function parseRuleFile(path: string, content: string): ImportedRule[] {
  let lines = content.replace(/\r\n/g, "\n").split("\n"), offset = 0, globs: string[] = [];
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) { globs = frontmatterGlobs(lines.slice(1, end).join("\n")); offset = end + 1; lines = lines.slice(end + 1); }
  }
  const items: { text: string; line: number; heading: string }[] = [];
  let heading = "", fenced = false, bullets = 0;
  for (const [i, raw] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(raw);
    if (h) { heading = strip(h[1]); continue; }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (bullet) bullets++;
    const text = strip(bullet ? bullet[1] : raw);
    if (text) items.push({ text, line: i + 1 + offset, heading: bullet ? heading : "\u0000" + heading });
  }
  // Bulleted files: bullets only. Plain files (often .cursorrules): every sentence-like line.
  const candidates = items.filter((item) => bullets ? !item.heading.startsWith("\u0000") : true).map((item) => ({ ...item, heading: item.heading.replace(/^\u0000/, "") }));
  const out: ImportedRule[] = [];
  for (const c of candidates) {
    if (c.text.length < 20 || c.text.length > 500 || !directive.test(c.text) || workflow.test(c.text)) continue;
    const words = c.text.replace(/[.:;]+$/, "").split(" ");
    const short = words.slice(0, 8).join(" ") + (words.length > 8 ? "…" : "");
    const title = (c.heading && c.heading.length <= 40 ? `${c.heading}: ${short}` : short).slice(0, 120);
    out.push({ title, instructions: c.text, globs, source: { path, line: c.line } });
  }
  return out;
}

// Candidates from every discovered file, deduplicated by wording, capped for one import request.
export function importCandidates(files: { path: string; content: string }[], limit = 50): ImportedRule[] {
  const seen = new Set<string>();
  const out: ImportedRule[] = [];
  for (const file of files) for (const rule of parseRuleFile(file.path, file.content)) {
    const key = rule.instructions.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out.slice(0, limit);
}
