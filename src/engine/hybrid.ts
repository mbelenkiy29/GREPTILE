// Hybrid retrieval ranking: vector similarity, full-text relevance and code-graph proximity are
// each normalized to [0,1] (best hit = 1) and combined with fixed weights. Sources that are
// unavailable (e.g. no embedding endpoint) simply contribute nothing.
export type RankedHit = { path: string; score: number; startLine?: number; endLine?: number; reason?: string };
export const hybridWeights = { vector: 0.5, text: 0.3, graph: 0.2 };

export function hybridRank(sources: { vector?: RankedHit[]; text?: RankedHit[]; graph?: RankedHit[] }, limit = 20, weights = hybridWeights) {
  const combined = new Map<string, { path: string; score: number; parts: { vector: number; text: number; graph: number }; lines?: { startLine: number; endLine?: number } }>();
  for (const kind of ["vector", "text", "graph"] as const) {
    const hits = sources[kind] ?? [];
    const best = new Map<string, RankedHit>();
    for (const hit of hits) if (Number.isFinite(hit.score) && hit.score > 0 && (!best.has(hit.path) || best.get(hit.path)!.score < hit.score)) best.set(hit.path, hit);
    const top = Math.max(0, ...[...best.values()].map((h) => h.score));
    if (!top) continue;
    for (const hit of best.values()) {
      const entry = combined.get(hit.path) ?? { path: hit.path, score: 0, parts: { vector: 0, text: 0, graph: 0 } };
      entry.parts[kind] = hit.score / top;
      if (hit.startLine && (!entry.lines || kind === "vector")) entry.lines = { startLine: hit.startLine, endLine: hit.endLine };
      combined.set(hit.path, entry);
    }
  }
  return [...combined.values()]
    .map((e) => ({ ...e, score: Math.round((e.parts.vector * weights.vector + e.parts.text * weights.text + e.parts.graph * weights.graph) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((e) => ({ path: e.path, score: e.score, ...(e.lines ? e.lines : {}), reason: (["vector", "text", "graph"] as const).filter((k) => e.parts[k] > 0).map((k) => (k === "vector" ? "semantic" : k === "text" ? "full-text" : "graph")).join(" + ") + " match" }));
}
