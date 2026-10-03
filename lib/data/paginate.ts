/** Page-based pagination shared by the dashboard's data functions (R6.13): `page` is 1-based, `pageSize` ≤ 100. */

export const MAX_PAGE_SIZE = 100;
/** Deepest page a list serves; beyond it the user should narrow the filters. */
export const MAX_PAGE = 1_000;

export interface PageOptions {
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Normalized page, page size, and row offset for untrusted page options. */
export function pageWindow(opts: PageOptions = {}, defaultSize = 25): { page: number; pageSize: number; offset: number } {
  const rawSize = Number.isFinite(opts.pageSize) ? Math.floor(opts.pageSize!) : defaultSize;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));
  const rawPage = Number.isFinite(opts.page) ? Math.floor(opts.page!) : 1;
  const page = Math.min(MAX_PAGE, Math.max(1, rawPage));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function toPage<T>(items: T[], total: number, window: { page: number; pageSize: number }): Page<T> {
  return {
    items,
    total,
    page: window.page,
    pageSize: window.pageSize,
    pageCount: Math.max(1, Math.ceil(total / window.pageSize)),
  };
}
