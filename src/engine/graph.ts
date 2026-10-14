// Bounded, ranked multi-hop traversal over resolved code-graph edges. Pure: the neighbour
// lookup is injected, so Convex (indexed queries) and in-memory indexes share the ranking.
export type GraphEdge = { from: string; to: string; kind: string; symbol?: string; resolved?: boolean };
export type GraphNeighbor = { path: string; hops: number; score: number; via: string };

export const edgeWeights: Record<string, number> = {
  calls: 1, "schema-to-consumer": 0.9, imports: 0.8, extends: 0.8, implements: 0.8,
  "route-to-handler": 0.7, contains: 0.7, exports: 0.6, "tested-by": 0.6, references: 0.5, "depends-on": 0.2,
};
// Legacy rows have no `resolved` flag: their import edges already hold resolved paths, while
// their call edges hold raw callee text and are not traversable.
export const traversable = (e: GraphEdge) => e.resolved === true || (e.resolved === undefined && e.kind !== "calls" && e.kind !== "route-to-handler");

export async function rankNeighborhood(
  seeds: string[],
  neighbors: (path: string) => Promise<{ path: string; kind: string; incoming: boolean }[]>,
  options: { hops?: number; limit?: number; fanout?: number } = {},
): Promise<GraphNeighbor[]> {
  const hops = Math.min(3, Math.max(1, options.hops ?? 2)), limit = Math.min(200, options.limit ?? 40), fanout = options.fanout ?? 30;
  const seedSet = new Set(seeds), best = new Map<string, GraphNeighbor>();
  let frontier = [...seedSet].map((path) => ({ path, score: 1 }));
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = new Map<string, { path: string; score: number }>();
    for (const node of frontier.slice(0, fanout)) {
      for (const edge of (await neighbors(node.path)).slice(0, 60)) {
        if (seedSet.has(edge.path) || edge.path === node.path) continue;
        // Callers of changed code (incoming calls) matter as much as its dependencies.
        const score = node.score * (edgeWeights[edge.kind] ?? 0.3) * (hop === 1 ? 1 : 0.5);
        const current = best.get(edge.path);
        if (!current) best.set(edge.path, { path: edge.path, hops: hop, score, via: edge.kind + (edge.incoming ? " (incoming)" : "") });
        else { current.score += score; current.hops = Math.min(current.hops, hop); }
        const queued = next.get(edge.path);
        if (!queued || queued.score < score) next.set(edge.path, { path: edge.path, score });
      }
    }
    frontier = [...next.values()].filter((n) => best.get(n.path)!.hops === hop).sort((a, b) => b.score - a.score);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.hops - b.hops || a.path.localeCompare(b.path)).slice(0, limit).map((n) => ({ ...n, score: Math.round(n.score * 1000) / 1000 }));
}

// Directory targets (Go packages, wildcard/package imports) end with "/" and expand to their
// files; importers of a directory count as incoming edges for each file inside it.
export const directoryOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

// In-memory neighbour lookup for indexed edges (CLI, evaluation, tests).
export function memoryNeighbors(edges: GraphEdge[], paths: string[]) {
  const usable = edges.filter(traversable);
  const expand = (target: string) => (target.endsWith("/") ? paths.filter((p) => p.startsWith(target) && !p.slice(target.length).includes("/")).slice(0, 20) : [target]);
  return async (path: string) => {
    const out: { path: string; kind: string; incoming: boolean }[] = [], dir = directoryOf(path);
    for (const e of usable) {
      if (e.from === path) for (const target of expand(e.to)) out.push({ path: target, kind: e.kind, incoming: false });
      if (e.to === path || (dir && e.to === dir)) out.push({ path: e.from, kind: e.kind, incoming: true });
    }
    return out;
  };
}
