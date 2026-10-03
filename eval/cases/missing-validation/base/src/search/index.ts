export interface SearchHit {
  id: string;
  title: string;
  score: number;
}

export interface SearchIndex {
  /** Hits for `q`, best first; loads `offset + limit` hits from the index into memory. */
  search(q: string, limit: number, offset?: number): SearchHit[];
}
