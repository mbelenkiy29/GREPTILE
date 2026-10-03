import Link from "next/link";
import { hrefWith, type QueryState } from "@/lib/ui/url";
import { Icon } from "./icons";

/** Page numbers to show around `page`: first, last, and a window, with gaps as null. */
export function pageList(page: number, pageCount: number, window = 1): (number | null)[] {
  const pages = new Set<number>([1, pageCount]);
  for (let p = page - window; p <= page + window; p++) if (p >= 1 && p <= pageCount) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1]! > 1) out.push(null);
    out.push(p);
  });
  return out;
}

/** URL-driven pagination (`?page=`), keeping the other query parameters. */
export function Pagination({
  pathname,
  state,
  page,
  pageCount,
  total,
  pageSize,
  noun = "items",
}: {
  pathname: string;
  state: QueryState;
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  noun?: string;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const href = (p: number) => hrefWith(pathname, state, { page: p === 1 ? undefined : p });
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="num">
        {total === 0 ? `No ${noun}` : `${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun}`}
      </span>
      {pageCount > 1 && (
        <ul>
          <li>
            {page > 1 ? (
              <Link href={href(page - 1)} aria-label="Previous page" rel="prev">
                <Icon name="chevron-left" size={14} />
              </Link>
            ) : (
              <span className="page" aria-disabled="true">
                <Icon name="chevron-left" size={14} />
                <span className="sr-only">Previous page</span>
              </span>
            )}
          </li>
          {pageList(page, pageCount).map((p, i) =>
            p === null ? (
              <li key={`gap-${i}`}>
                <span className="page" aria-hidden="true">
                  …
                </span>
              </li>
            ) : (
              <li key={p}>
                {p === page ? (
                  <span className="page" aria-current="page">
                    {p}
                  </span>
                ) : (
                  <Link href={href(p)} aria-label={`Page ${p}`}>
                    {p}
                  </Link>
                )}
              </li>
            ),
          )}
          <li>
            {page < pageCount ? (
              <Link href={href(page + 1)} aria-label="Next page" rel="next">
                <Icon name="chevron-right" size={14} />
              </Link>
            ) : (
              <span className="page" aria-disabled="true">
                <Icon name="chevron-right" size={14} />
                <span className="sr-only">Next page</span>
              </span>
            )}
          </li>
        </ul>
      )}
    </nav>
  );
}
