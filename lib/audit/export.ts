/**
 * CSV export of the audit log (R4.6): `GET /api/orgs/current/audit.csv?actor=&action=&from=&to=`, streamed in
 * batches so exports of any size use constant memory. The org always comes from the caller's session, never the
 * request; cells are CSV-injection-safe (lib/data/audit `csvCell`).
 */
import type { OrgContext } from "@/lib/auth/request";
import type { Db } from "@/lib/db";
import { auditCsvStream, auditFilterFromQuery, recordAudit } from "@/lib/data/audit";
import { requestMetadata } from "@/lib/auth/sessions";

export interface AuditCsvDeps {
  db: Db;
  authorize: (req: Request) => Promise<{ ok: true; ctx: OrgContext } | { ok: false; response: Response }>;
  now?: () => Date;
}

export function createAuditCsvHandler(factory: () => AuditCsvDeps) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const auth = await deps.authorize(req);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;
    const params = new URL(req.url).searchParams;
    const filter = auditFilterFromQuery((k) => params.get(k));
    const now = (deps.now ?? (() => new Date()))();
    // Exporting the trail is itself an audited action.
    await recordAudit(deps.db, {
      orgId: ctx.orgId,
      actorType: "user",
      actorId: ctx.userId,
      action: "audit.exported",
      targetType: "org",
      targetId: ctx.orgId,
      metadata: { filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() } },
      ip: requestMetadata(req).ip,
      now,
    });
    const stamp = now.toISOString().slice(0, 10);
    return new Response(auditCsvStream(deps.db, ctx.orgId, filter), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${ctx.orgSlug.replace(/[^\w-]/g, "")}-${stamp}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
