import Link from "next/link";
import { hrefWith, type QueryState } from "@/lib/ui/url";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

/**
 * URL-driven tabs (`?tab=`): each tab is a link, so tabs work without JavaScript and are shareable. The first tab is
 * the default and has no `tab` parameter.
 */
export function Tabs({
  tabs,
  current,
  pathname,
  state,
  paramKey = "tab",
  label,
}: {
  tabs: TabItem[];
  current: string;
  pathname: string;
  state: QueryState;
  paramKey?: string;
  label: string;
}) {
  const first = tabs[0]?.id;
  return (
    <nav className="tabs" aria-label={label}>
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={hrefWith(pathname, state, { [paramKey]: t.id === first ? undefined : t.id, page: undefined })}
          aria-current={t.id === current ? "page" : undefined}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count.toLocaleString("en-US")}</span>}
        </Link>
      ))}
    </nav>
  );
}
