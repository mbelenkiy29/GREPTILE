// Deterministic layout for the guided-setup code graph: indexed file paths become nodes on
// directory rings, connected by module references (or, without any, by shared folders).
export type GraphNode = { id: string; label: string; x: number; y: number };
export type GraphLayout = { nodes: GraphNode[]; edges: [number, number][]; placeholder: boolean };

// FNV-1a: stable positions for the same paths on every render and server.
function hash(value: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const folder = (path: string) => path.split("/").slice(0, -1).join("/");
export const basename = (path: string) => path.split("/").pop() ?? path;

/** Nodes for up to `limit` paths in a `size`×`size` box; a placeholder constellation when empty. */
export function graphLayout(paths: readonly string[], references: readonly (readonly [string, string])[], size = 320, limit = 36): GraphLayout {
  const unique = [...new Set(paths)].sort().slice(0, limit);
  const placeholder = unique.length === 0;
  const ids = placeholder ? Array.from({ length: 18 }, (_, i) => `node-${i}`) : unique;
  const folders = [...new Set(ids.map(folder))].sort();
  const center = size / 2, rings = [0.3, 0.55, 0.8].map((r) => r * (center - 16));
  const nodes = ids.map((id) => {
    const h = hash(id), ring = rings[(placeholder ? h : folders.indexOf(folder(id))) % rings.length];
    const angle = ((h % 3600) / 3600) * Math.PI * 2, jitter = ((h >>> 12) % 13) - 6;
    return { id, label: placeholder ? "" : basename(id), x: Math.round(center + Math.cos(angle) * (ring + jitter)), y: Math.round(center + Math.sin(angle) * (ring + jitter)) };
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  let edges = references.map(([a, b]) => [index.get(a), index.get(b)]).filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1]);
  if (!edges.length) {
    // No resolved references yet: link files that share a folder, in path order.
    edges = [];
    const byFolder = new Map<string, number[]>();
    ids.forEach((id, i) => byFolder.set(placeholder ? String(hash(id) % 5) : folder(id), [...(byFolder.get(placeholder ? String(hash(id) % 5) : folder(id)) ?? []), i]));
    for (const members of byFolder.values()) for (let i = 1; i < members.length; i++) edges.push([members[i - 1], members[i]]);
  }
  return { nodes, edges: edges.slice(0, 60), placeholder };
}

/** How many of `count` nodes to show as indexed for the given job progress. */
export function litCount(count: number, processed: number, total: number) {
  if (count <= 0) return 0;
  if (total <= 0) return processed > 0 ? count : 0;
  return Math.max(0, Math.min(count, Math.round((count * processed) / total)));
}
