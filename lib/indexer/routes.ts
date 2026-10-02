/** Route path helpers shared by the framework extractors (R6.3). Route symbols are named like `GET /api/users/:id`. */

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * Normalizes framework path syntax to `:param` segments: `{id}`/`{id:int}` (FastAPI, Spring, ASP.NET, chi),
 * `<int:id>` (Flask/Django), `[id]`/`[...slug]` (Next.js). Ensures a leading slash and drops a trailing one.
 */
export function normalizeRoutePath(raw: string): string {
  let p = raw.trim().replace(/^~/, "");
  p = p.replace(/\[\[?\.\.\.([A-Za-z_]\w*)\]?\]/g, ":$1*");
  p = p.replace(/\[([A-Za-z_]\w*)\]/g, ":$1");
  p = p.replace(/\{\*?([A-Za-z_]\w*)(?::[^}]*)?\}/g, ":$1");
  p = p.replace(/<(?:[A-Za-z_]\w*:)?([A-Za-z_]\w*)>/g, ":$1");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

export function joinRoutePaths(prefix: string, path: string): string {
  if (!prefix) return normalizeRoutePath(path);
  if (!path || path === "/") return normalizeRoutePath(prefix);
  return normalizeRoutePath(`${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}

export function routeName(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeRoutePath(path)}`;
}

/** URL path of a Next.js app-router `route.ts` (or `pages/api/*`) file, or null if the path is not one. */
export function nextRoutePath(filePath: string): { path: string; style: "app" | "pages" } | null {
  const segs = filePath.split("/");
  const file = segs[segs.length - 1]!;
  const appIdx = segs.lastIndexOf("app");
  if (/^route\.[cm]?[jt]sx?$/.test(file) && appIdx >= 0 && appIdx < segs.length - 1) {
    const parts = segs
      .slice(appIdx + 1, -1)
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
    return { path: normalizeRoutePath(`/${parts.join("/")}`), style: "app" };
  }
  const pagesIdx = segs.lastIndexOf("pages");
  if (pagesIdx >= 0 && segs[pagesIdx + 1] === "api" && /\.[cm]?[jt]sx?$/.test(file)) {
    const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
    const parts = [...segs.slice(pagesIdx + 1, -1), ...(stem === "index" ? [] : [stem])];
    return { path: normalizeRoutePath(`/${parts.join("/")}`), style: "pages" };
  }
  return null;
}
