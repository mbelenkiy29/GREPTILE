import { ReposTable } from "@/components/dashboard/ReposTable";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listRepos } from "@/lib/data/installations";
import { reindexRepo, toggleRepo } from "./actions";

const INSTALL_MESSAGES: Record<string, string> = {
  ok: "GitHub connected. Selected repositories are being indexed.",
  invalid_state: "The install link expired or belongs to another organization. Please try again.",
  missing_installation: "GitHub did not return an installation. Please try again.",
  owned_elsewhere: "That GitHub installation is already connected to another organization.",
};

export default async function ReposPage({ searchParams }: { searchParams: Promise<{ install?: string }> }) {
  const { orgId } = await requireOrg();
  const repos = await listRepos(db(), orgId);
  const { install } = await searchParams;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Repositories</h1>
        <a className="button button-primary" href="/api/github/install">
          {repos.length ? "Add repositories" : "Connect GitHub"}
        </a>
      </div>
      {install && INSTALL_MESSAGES[install] && <p className="notice">{INSTALL_MESSAGES[install]}</p>}
      <div className="table-wrap">
        <ReposTable
          repos={repos}
          actions={(r) => (
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
        />
      </div>
    </div>
  );
}
