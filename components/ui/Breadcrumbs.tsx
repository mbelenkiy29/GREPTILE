import Link from "next/link";

/** Breadcrumb trail; the last item is the current page. */
export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${i}-${it.label}`}>
              {last || !it.href ? (
                <span aria-current={last ? "page" : undefined} className="truncate">
                  {it.label}
                </span>
              ) : (
                <Link href={it.href}>{it.label}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
