import type { SearchIndex } from "../search/index";

/** GET /search?q= — the top 20 hits. */
export function searchRoute(index: SearchIndex) {
  return (query: Record<string, string | undefined>) => {
    const q = (query.q ?? "").trim();
    if (!q) return { status: 400, body: { error: "q is required" } };
    if (q.length > 200) return { status: 400, body: { error: "q is too long" } };
    return { status: 200, body: index.search(q, 20) };
  };
}
