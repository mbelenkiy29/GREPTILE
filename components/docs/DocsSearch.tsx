"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { searchDocs, type SearchDoc, type SearchHit } from "@/lib/docs/search";

/** Where the build-time search index is served (same origin; no third-party search). */
export const SEARCH_INDEX_URL = "/docs/search.json";

/**
 * Docs search (R5.3): loads the build-time index on first use and ranks pages in the browser. Results are a list of
 * links announced through a live region; the form works with the keyboard alone.
 */
export function DocsSearch() {
  const id = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const index = useRef<Promise<SearchDoc[] | null> | null>(null);
  const latest = useRef("");

  function ensureIndex(): Promise<SearchDoc[] | null> {
    if (index.current) return index.current;
    setState("loading");
    index.current = fetch(SEARCH_INDEX_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const docs = (await res.json()) as SearchDoc[];
        setState("ready");
        return docs;
      })
      .catch(() => {
        // Let the next keystroke try again.
        index.current = null;
        setState("error");
        return null;
      });
    return index.current;
  }

  async function update(q: string) {
    setQuery(q);
    latest.current = q;
    const docs = await ensureIndex();
    // Only the newest query may set results (an earlier one can resolve after it while the index loads).
    if (latest.current === q) setHits(docs ? searchDocs(docs, q) : []);
  }

  const showResults = query.trim().length >= 2;
  return (
    <div className="docs-search" role="search">
      <label htmlFor={`${id}-q`} className="sr-only">
        Search the docs
      </label>
      <input
        id={`${id}-q`}
        type="search"
        className="input"
        placeholder="Search the docs"
        autoComplete="off"
        value={query}
        onFocus={() => void ensureIndex()}
        onChange={(e) => void update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") void update("");
        }}
        aria-describedby={`${id}-status`}
      />
      <p id={`${id}-status`} className="sr-only" aria-live="polite">
        {state === "error" ? "Search is unavailable." : showResults ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : ""}
      </p>
      {showResults && (
        <ul className="docs-search-results">
          {hits.length === 0 && state !== "loading" && <li className="dim">No pages match “{query.trim()}”.</li>}
          {hits.map((h) => (
            <li key={h.href}>
              <Link href={h.href} onClick={() => void update("")}>
                <span className="strong">{h.title}</span>
                <span className="dim">{h.excerpt}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
