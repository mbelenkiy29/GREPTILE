import Link from "next/link";
import type { ReactNode } from "react";
import { hrefWith, type QueryState } from "@/lib/ui/url";
import { Icon } from "./icons";

/**
 * A data table: horizontally scrollable on narrow screens, with a sticky header (`scroll` caps its height so the
 * header sticks while the body scrolls). `caption` is the accessible name.
 */
export function Table({
  caption,
  captionHidden = true,
  compact = false,
  scroll = false,
  children,
}: {
  caption: string;
  captionHidden?: boolean;
  compact?: boolean;
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="table-wrap" data-scroll={scroll ? "y" : undefined} tabIndex={0} role="region" aria-label={caption}>
      <table className={compact ? "table table-compact" : "table"}>
        <caption className={captionHidden ? "sr-only" : "dim"}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}

/**
 * A sortable column header: a link that sorts by `field` (toggling direction when already sorted by it), with
 * `aria-sort` on the header cell.
 */
export function SortHeader({
  label,
  field,
  pathname,
  state,
  sortKey = "sort",
  dirKey = "dir",
  defaultField,
  defaultDir = "desc",
  numeric = false,
}: {
  label: string;
  field: string;
  pathname: string;
  state: QueryState;
  sortKey?: string;
  dirKey?: string;
  defaultField: string;
  defaultDir?: "asc" | "desc";
  numeric?: boolean;
}) {
  const current = state[sortKey] ?? defaultField;
  const dir = (state[dirKey] as "asc" | "desc" | undefined) ?? defaultDir;
  const active = current === field;
  const nextDir = active ? (dir === "asc" ? "desc" : "asc") : "desc";
  const href = hrefWith(pathname, state, { [sortKey]: field, [dirKey]: nextDir, page: undefined });
  return (
    <th scope="col" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} className={numeric ? "num" : undefined}>
      <Link className="sort-link" href={href} aria-current={active ? "true" : undefined}>
        {label}
        <Icon name={active ? (dir === "asc" ? "arrow-up" : "arrow-down") : "sort"} size={12} />
        <span className="sr-only">{active ? `, sorted ${dir === "asc" ? "ascending" : "descending"}` : ", sortable"}</span>
      </Link>
    </th>
  );
}

/** Primary and secondary text of a table cell. */
export function CellTitle({ href, children, sub, external = false }: { href?: string; children: ReactNode; sub?: ReactNode; external?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      {href ? (
        external ? (
          <a className="cell-title" href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ) : (
          <Link className="cell-title" href={href}>
            {children}
          </Link>
        )
      ) : (
        <div className="cell-title">{children}</div>
      )}
      {sub && <div className="cell-sub">{sub}</div>}
    </div>
  );
}
