/**
 * Docs search ranking (R5.3), shared by the browser island and tests. The index is built at build time
 * (`buildSearchIndex`) and fetched from the app's own origin; nothing is sent to a third party.
 */

export interface SearchDoc {
  href: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
}

export interface SearchHit {
  href: string;
  title: string;
  /** A short excerpt around the first match in the page text (or the description). */
  excerpt: string;
  score: number;
}

/** Lower-cased query words (at least two characters each). */
export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length >= 2);
}

function excerpt(text: string, term: string, width = 140): string {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return "";
  const start = Math.max(0, i - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Pages matching every query word, best first: title matches weigh most, then headings, description, and text. */
export function searchDocs(index: readonly SearchDoc[], query: string, limit = 8): SearchHit[] {
  const words = terms(query);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const doc of index) {
    const title = doc.title.toLowerCase();
    const headings = doc.headings.join(" \n ").toLowerCase();
    const description = doc.description.toLowerCase();
    const text = doc.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = (title.includes(w) ? 10 : 0) + (headings.includes(w) ? 4 : 0) + (description.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    const first = words[0]!;
    hits.push({ href: doc.href, title: doc.title, excerpt: excerpt(doc.text, first) || doc.description, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
