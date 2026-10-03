import type { Metadata } from "next";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Pagination } from "@/components/ui/Pagination";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { AUDIT_CATEGORIES, auditActors, auditFilterFromQuery, listAuditPage, type AuditListItem } from "@/lib/data/audit";
import { enterpriseEnv } from "@/lib/env";
import { formatDate } from "@/lib/ui/format";
import { intParam, param, queryState, type SearchParams } from "@/lib/ui/url";

export const metadata: Metadata = { title: "Audit log" };

const PATH = "/dashboard/settings/audit";

function actorLabel(r: AuditListItem): string {
  if (r.actorType === "user") return r.actorName ?? (r.actorId ? `Deleted user (${r.actorId})` : "Unknown user");
  if (r.actorType === "api_key") return `API key ${r.actorId ?? ""}`.trim();
  return `System (${r.actorId ?? "openreview"})`;
}

function details(r: AuditListItem): string {
  const parts = Object.entries(r.metadata)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return parts.join(" · ").slice(0, 300);
}

/** Settings → Audit log (R4.6): who changed what, filterable, paginated, and exportable as CSV. Owners and admins. */
export default async function AuditLogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireOrg({ permission: "audit.read" });
  const sp = await searchParams;
  const filter = auditFilterFromQuery((k) => param(sp, k));
  const [page, actors] = await Promise.all([listAuditPage(db(), ctx.orgId, { ...filter, page: intParam(sp, "page"), pageSize: 50 }), auditActors(db(), ctx.orgId)]);
  const state = queryState(sp);
  const exportQuery = new URLSearchParams(Object.entries(state).filter(([k]) => k !== "page")).toString();
  const retention = enterpriseEnv().AUDIT_RETENTION_DAYS;
  return (
    <Card
      title="Audit log"
      titleId="audit-heading"
      description={`Admin actions and review events in ${ctx.orgName}, kept for ${retention} days.`}
      actions={
        <a className="button button-sm" href={`/api/orgs/current/audit.csv${exportQuery ? `?${exportQuery}` : ""}`} download>
          Export CSV
        </a>
      }
      flush
    >
      <form className="filter-bar" action={PATH} aria-label="Filter the audit log" data-testid="audit-filters">
        <div className="field">
          <label className="field-label" htmlFor="audit-actor">
            Actor
          </label>
          <select id="audit-actor" name="actor" className="select" defaultValue={param(sp, "actor") ?? ""}>
            <option value="">Anyone</option>
            {actors.map((a) => (
              <option key={`${a.actorType}:${a.actorId}`} value={a.actorId}>
                {a.actorType === "user" ? (a.name ?? a.actorId) : a.actorType === "api_key" ? `API key ${a.actorId}` : `System (${a.actorId})`}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="audit-action">
            Action
          </label>
          <select id="audit-action" name="action" className="select" defaultValue={param(sp, "action") ?? ""}>
            <option value="">Everything</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="audit-from">
            From
          </label>
          <input id="audit-from" name="from" type="date" className="input" defaultValue={param(sp, "from") ?? ""} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="audit-to">
            To
          </label>
          <input id="audit-to" name="to" type="date" className="input" defaultValue={param(sp, "to") ?? ""} />
        </div>
        <div className="filter-bar-actions">
          <button className="button" type="submit">
            Apply
          </button>
        </div>
      </form>
      {page.items.length ? (
        <>
          <Table caption="Audit log entries">
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Details</th>
                <th scope="col">IP</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((r) => (
                <tr key={r.id} data-audit-action={r.action}>
                  <td className="nowrap" title={r.createdAt.toISOString()}>
                    {formatDate(r.createdAt)} {r.createdAt.toISOString().slice(11, 19)}
                  </td>
                  <td>{actorLabel(r)}</td>
                  <td>
                    <Badge tone="outline" mono>
                      {r.action}
                    </Badge>
                  </td>
                  <td className="mono">{r.targetType ? `${r.targetType}${r.targetId ? ` ${r.targetId}` : ""}` : "—"}</td>
                  <td className="dim">{details(r) || "—"}</td>
                  <td className="mono nowrap">{r.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination pathname={PATH} state={state} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun="entries" />
        </>
      ) : (
        <p className="card-body dim">No audit entries match these filters.</p>
      )}
    </Card>
  );
}
