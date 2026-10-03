import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Table } from "@/components/ui/Table";
import type { FailureItem } from "@/lib/data/activity";
import { formatRelative } from "@/lib/ui/format";

const KIND_LABEL = { delivery: "Webhook", index: "Indexing", review: "Review" } as const;

/** "What went wrong recently": failed deliveries, index runs, and review runs in one list (R6.13). */
export function FailureFeed({ items, now = new Date(), action }: { items: FailureItem[]; now?: Date; action?: (item: FailureItem) => ReactNode }) {
  return (
    <Table caption="Recent failures">
      <thead>
        <tr>
          <th scope="col">What failed</th>
          <th scope="col">Repository</th>
          <th scope="col">Error</th>
          <th scope="col">When</th>
          {action && (
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={`${it.kind}:${it.id}`} data-failure={`${it.kind}:${it.id}`}>
            <td>
              <div className="row-tight">
                <Badge tone="bad" dot>
                  {KIND_LABEL[it.kind]}
                </Badge>
                <Link className="cell-title" href={it.href}>
                  {it.title}
                </Link>
              </div>
            </td>
            <td>{it.repoFullName ?? <span className="dim">—</span>}</td>
            <td className="error-text break" style={{ maxWidth: 420 }}>
              {it.error ?? "No error recorded"}
            </td>
            <td className="nowrap">{formatRelative(it.at, now)}</td>
            {action && <td>{action(it)}</td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
