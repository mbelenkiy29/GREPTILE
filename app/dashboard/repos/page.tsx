import { ReposTable } from "@/components/dashboard/ReposTable";
import { requireOrg } from "@/lib/auth";
import { installMessage } from "@/lib/auth/messages";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listRepos } from "@/lib/data/installations";
import { reindexRepo, toggleRepo } from "./actions";

export default async function ReposPage({ searchParams }: { searchParams: Promise<{ install?: string }> }) {
  const { orgId, role } = await requireOrg();
  const manage = can(role, "repos.manage");
  const repos = await listRepos(db(), orgId);
  const { install } = await searchParams;
  const message = installMessage(install);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Repositories</h1>
        {manage && (
          <a className="button button-primary" href="/api/github/install">
            {repos.length ? "Add repositories" : "Connect GitHub"}
          </a>
        )}
      </div>
      {message && <p className={install === "ok" || install === "requested" ? "notice" : "notice notice-bad"}>{message}</p>}
      <div className="table-wrap">
        <ReposTable
          repos={repos}
          actions={(r) => (
            <>
              <a className="button" href={`/dashboard/repos/${r.id}`}>Settings</a>
              {manage && (
                <>
                  <form action={toggleRepo}>
                    <input type="hidden" name="repoId" value={r.id} />
                    <input type="hidden" name="enabled" value={String(!r.enabled)} />
                    <button className="button" type="submit">{r.enabled ? "Pause reviews" : "Resume reviews"}</button>
                  </form>
                  <form action={reindexRepo}>
                    <input type="hidden" name="repoId" value={r.id} />
                    <button className="button" type="submit" disabled={r.indexStatus === "indexing"}>Re-index</button>
                  </form>
                </>
              )}
            </>
          )}
        />
      </div>
    </div>
  );
}
