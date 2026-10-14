// Knowledge base entries as review background: only entries about the changed code, ranked by how
// directly they cover it, bounded by an approximate token budget, and labelled as derived text that
// can never serve as evidence (evidence quotes must match source lines).
export type KnowledgeEntry = { subsystem: string; description: string; files: string[]; dependencies: string[]; risks: string[]; conventions: string[]; updatedAt: number };
export type KnowledgeBackground = { subsystem: string; description: string; risks: string[]; conventions: string[]; files: string[] };
export const knowledgeTokenBudgets = { fast: 800, standard: 1500, deep: 3000 } as const;
export const knowledgeNote = "Derived background written by OpenReview about this repository at an earlier indexed revision. It is not source code and may be outdated: use it to decide what to check, never quote it as evidence, and prefer the current source when they disagree.";
const clip = (text: string, limit: number) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > limit ? t.slice(0, limit - 1) + "…" : t; };
const dir = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export function selectKnowledge(entries: KnowledgeEntry[], changedPaths: string[], headPaths: ReadonlySet<string>, tokens: number) {
  const changed = new Set(changedPaths), dirs = new Set(changedPaths.map(dir));
  let stale = 0;
  const ranked = entries.flatMap((entry) => {
    // Entries whose files are all gone describe deleted code: skip them rather than mislead.
    const live = entry.files.filter((f) => headPaths.has(f));
    if (!live.length) { if (entry.files.length) stale++; return []; }
    const direct = live.filter((f) => changed.has(f)).length, nearby = live.filter((f) => !changed.has(f) && dirs.has(dir(f))).length;
    const score = direct * 10 + nearby * 3;
    return score ? [{ entry, live, score }] : [];
  }).sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt || a.entry.subsystem.localeCompare(b.entry.subsystem));
  const selected: KnowledgeBackground[] = [];
  let used = 0;
  for (const { entry, live } of ranked) {
    const item: KnowledgeBackground = { subsystem: clip(entry.subsystem, 100), description: clip(entry.description, 600), risks: entry.risks.slice(0, 5).map((r) => clip(r, 200)), conventions: entry.conventions.slice(0, 5).map((c) => clip(c, 200)), files: live.slice(0, 20) };
    const cost = Math.ceil(JSON.stringify(item).length / 4);
    if (used + cost > tokens) continue;
    used += cost;
    selected.push(item);
  }
  return { selected, tokens: used, stale };
}
