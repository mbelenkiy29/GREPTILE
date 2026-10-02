const STOP = new Set(["the", "and", "for", "not", "this", "that", "with", "are", "was", "but", "its", "can", "may", "should", "could", "from", "into", "when", "will"]);

export function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((t) => !STOP.has(t)));
}

/** Jaccard similarity of word tokens, 0..1. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
