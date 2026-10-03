import { authorizeRequest } from "@/lib/auth/request";
import type { SessionClock } from "@/lib/auth/sessions";
import type { Db } from "@/lib/db";
import { errorMessage, log } from "@/lib/log";
import { usageCsv, usageRangeFromQuery } from "./usage";

/**
 * `GET /api/orgs/current/usage/export?period=&from=&to=` (R4.3): the active org's usage events for the period as a
 * streamed CSV download. Any member may read usage; the org always comes from the session.
 */
export function createUsageExportHandler(factory: () => { db: Db; clock: SessionClock }) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const auth = await authorizeRequest(deps, req);
    if (!auth.ok) return auth.response;
    const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
    const range = usageRangeFromQuery(sp, deps.clock.now);
    const rows = usageCsv(deps.db, auth.ctx.orgId, range);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await rows.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (err) {
          log.error("usage export failed", { orgId: auth.ctx.orgId, error: errorMessage(err) });
          controller.error(err);
        }
      },
      async cancel() {
        await rows.return(undefined);
      },
    });
    const name = `openreview-usage-${auth.ctx.orgSlug}-${range.start.toISOString().slice(0, 10)}-${new Date(range.end.getTime() - 1).toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
