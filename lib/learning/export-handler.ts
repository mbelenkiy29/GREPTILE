import { authorizeRequest } from "@/lib/auth/request";
import type { SessionClock } from "@/lib/auth/sessions";
import type { Db } from "@/lib/db";
import { exportPreferences } from "./preferences";

/**
 * `GET /api/orgs/current/preferences/export[?repoId=]` (R6.10): the active org's learned preferences as a JSON
 * download. Any member may read them; the org always comes from the session.
 */
export function createPreferencesExportHandler(factory: () => { db: Db; clock: SessionClock }) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const auth = await authorizeRequest(deps, req);
    if (!auth.ok) return auth.response;
    const raw = new URL(req.url).searchParams.get("repoId");
    const repoId = raw ? Number(raw) : undefined;
    if (repoId !== undefined && !(Number.isSafeInteger(repoId) && repoId > 0)) {
      return Response.json({ error: "invalid_repo" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const doc = await exportPreferences(deps.db, auth.ctx.orgId, { ...(repoId !== undefined ? { repoId } : {}), now: deps.clock.now });
    const day = doc.exportedAt.slice(0, 10);
    return new Response(JSON.stringify(doc, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="openreview-preferences-${auth.ctx.orgSlug}-${day}.json"`,
        "cache-control": "no-store",
      },
    });
  };
}
