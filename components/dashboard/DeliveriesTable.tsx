import Link from "next/link";
import { StatusPill } from "@/components/ui/Badge";
import { Table } from "@/components/ui/Table";
import { formatDuration, formatRelative } from "@/lib/ui/format";

export interface DeliveryRow {
  deliveryId: string;
  event: string;
  action: string | null;
  repoFullName: string | null;
  status: string;
  reason: string | null;
  jobs: string[];
  error: string | null;
  attempts: number;
  receivedAt: Date;
  durationMs: number | null;
  replayable: boolean;
}

/** Webhook deliveries and what happened to each (R6.21): event, repository, outcome, jobs queued, error. */
export function DeliveriesTable({ deliveries, now = new Date(), showRepo = true }: { deliveries: DeliveryRow[]; now?: Date; showRepo?: boolean }) {
  return (
    <Table caption="Webhook deliveries">
      <thead>
        <tr>
          <th scope="col">Event</th>
          {showRepo && <th scope="col">Repository</th>}
          <th scope="col">Outcome</th>
          <th scope="col">Jobs</th>
          <th scope="col">Received</th>
        </tr>
      </thead>
      <tbody>
        {deliveries.map((d) => (
          <tr key={d.deliveryId} data-delivery={d.deliveryId}>
            <td>
              <Link className="cell-title mono" href={`/dashboard/activity/${encodeURIComponent(d.deliveryId)}`}>
                {d.event}
                {d.action ? `.${d.action}` : ""}
              </Link>
              <div className="cell-sub mono truncate" style={{ maxWidth: 220 }}>
                {d.deliveryId}
              </div>
            </td>
            {showRepo && <td>{d.repoFullName ?? <span className="dim">—</span>}</td>}
            <td style={{ maxWidth: 360 }}>
              <StatusPill kind="delivery" value={d.status} />
              {d.attempts > 1 && <span className="dim"> · {d.attempts} attempts</span>}
              {(d.error || d.reason) && <div className={d.error ? "error-text break" : "dim break"}>{d.error ?? d.reason}</div>}
            </td>
            <td className="mono dim">{d.jobs.length ? d.jobs.length : "—"}</td>
            <td className="nowrap">
              {formatRelative(d.receivedAt, now)}
              <div className="dim">{formatDuration(d.durationMs)}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
