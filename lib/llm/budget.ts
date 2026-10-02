/**
 * Token budgets (R6.16): cheap, provider-independent estimates for keeping prompts inside a budget.
 * The estimate is ~4 characters per token, which errs high for code and English prose.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Marker used when the budget cannot hold any content (cut to the budget; empty only for a zero budget). */
const SHORT_MARKER = "[… truncated]";

function marker(omittedLines: number): string {
  return `[… truncated ${omittedLines} more line${omittedLines === 1 ? "" : "s"}]`;
}

/**
 * Cuts `text` to at most `maxTokens` estimated tokens, keeping whole lines and ending with a truncation marker
 * that says how many lines were dropped. Only when not even the first line fits is a line cut mid-way. A budget too
 * small for that returns just a (possibly shortened) "[… truncated]" marker; a zero budget returns "".
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const budget = Math.max(0, Math.floor(maxTokens) * 4);
  const lines = text.split("\n");
  // Reserve room for the widest marker this text can need (every line dropped).
  const reserve = marker(lines.length).length + 1;
  // Too small for a line and the full marker: return as much of a short marker as fits, so the cut is still visible.
  if (reserve > budget) return SHORT_MARKER.slice(0, budget);
  const room = budget - reserve;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) {
    const first = lines[0] ?? "";
    return `${first.slice(0, room)}\n${marker(lines.length)}`;
  }
  return `${kept.join("\n")}\n${marker(lines.length - kept.length)}`;
}

/**
 * Greedily keeps items in the given order while they fit in `budget` (as measured by `sizeOf`); an item that does
 * not fit is dropped and later, smaller items may still be kept. Callers order items by priority.
 */
export function fitItemsToBudget<T>(
  items: readonly T[],
  budget: number,
  sizeOf: (item: T) => number,
): { kept: T[]; dropped: T[]; used: number } {
  const kept: T[] = [];
  const dropped: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = Math.max(0, sizeOf(item));
    if (used + size <= budget) {
      kept.push(item);
      used += size;
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped, used };
}
