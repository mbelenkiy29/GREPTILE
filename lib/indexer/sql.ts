import { sql, type SQL } from "drizzle-orm";

/** Rows of a raw `db.execute` result across drivers (postgres-js returns an array, PGlite `{ rows }`). */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function quoteElement(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A `text[]` parameter (one bind value, any length), e.g. for `col = any(...)`. */
export function textArray(values: readonly string[]): SQL {
  return sql`${`{${values.map(quoteElement).join(",")}}`}::text[]`;
}

/** An `int[]` parameter (one bind value, any length). */
export function intArray(values: readonly number[]): SQL {
  return sql`${`{${values.map((v) => String(Math.trunc(v))).join(",")}}`}::int[]`;
}

export function chunked<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** `LIKE` pattern matching `s` literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
