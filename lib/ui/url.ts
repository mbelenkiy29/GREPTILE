/** URL-state helpers for server-rendered lists (R6.13): filters, sort, tabs, and pages live in the query string. */

export type SearchParams = Record<string, string | string[] | undefined>;
export type QueryState = Record<string, string>;

/** First value of a query parameter. */
export function param(params: SearchParams, key: string): string | undefined {
  const v = params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

/** Every non-empty value of a (possibly repeated, possibly comma-separated) query parameter. */
export function params(p: SearchParams, key: string): string[] {
  const v = p[key];
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

/** A positive integer parameter, or undefined. */
export function intParam(p: SearchParams, key: string): number | undefined {
  const s = param(p, key);
  if (!s || !/^\d{1,9}$/.test(s)) return undefined;
  const n = Number(s);
  return n > 0 ? n : undefined;
}

/** A parameter restricted to `allowed` values. */
export function enumParam<T extends string>(p: SearchParams, key: string, allowed: readonly T[]): T | undefined {
  const s = param(p, key);
  return s !== undefined && (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

/** A `YYYY-MM-DD` parameter as a UTC date, or undefined. */
export function dateParam(p: SearchParams, key: string): Date | undefined {
  const s = param(p, key);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The query as flat string pairs (first value of each key), without one-shot keys such as `toast`. */
export function queryState(p: SearchParams): QueryState {
  const out: QueryState = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "toast") continue;
    const s = Array.isArray(v) ? v.join(",") : v;
    if (s) out[k] = s;
  }
  return out;
}

/** `pathname` with `state` updated by `patch` (undefined or "" removes a key). Keys are sorted for stable URLs. */
export function hrefWith(pathname: string, state: QueryState, patch: Record<string, string | number | undefined> = {}): string {
  const merged: Record<string, string> = { ...state };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "") delete merged[k];
    else merged[k] = String(v);
  }
  const qs = new URLSearchParams(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))).toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
