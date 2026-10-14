import { providerDisplay } from "../../../src/provider-display";
import Link from "next/link";

import { configureRepository, reindex } from "../actions";
import { when, status, Empty } from "./shared";
import type { DashboardContext } from "../load";

export function RepositoriesSection({ ctx }: { ctx: DashboardContext }) {
  const { data, isAdmin, organization } = ctx;
  return (
(
          <>
            <div className="toolbar">
              <p>
                Enable a repository to build its codebase context and review new
                pull requests.
              </p>
              {isAdmin && (
                <a
                  className="button primary"
                  href={`/api/github/install?organization=${organization._id}`}
                >
                  Connect GitHub App
                </a>
              )}
            </div>
            {!data.repositories.length && (
              <Empty
                title="No repositories connected"
                text="Install the GitHub App above. Choose access to specific repositories in GitHub."
              />
            )}
            {data.repositories.map((r) => (
              <section className="repository" key={r._id}>
                <div className="row">
                  <div>
                    <h2>{r.fullName}</h2>
                    <p className="muted repository-identity">{providerDisplay(r.provider)}</p>
                    <p className="muted">
                      {r.defaultBranch}{" "}
                      {r.indexedSha && <> · <code>{r.indexedSha}</code></>}{" "}
                      {r.indexedAt && ` · ${when(r.indexedAt)}`}
                    </p>
                  </div>
                  {status(r.indexStatus)}
                </div>
                {r.indexStatus === "ready" && (
                  <p>
                    Ready for review. Open a change in your connected code provider
                    or select an existing change from Pull Requests to request a review.
                  </p>
                )}
                {data.indexJobs
                  .filter((j) => j?.repositoryId === r._id)
                  .map(
                    (j) =>
                      j && (
                        <div key={j._id}>
                          <p className="muted">
                            Processed {j.processed} of {j.total} eligible files · Attempt{" "}
                            {j.attempts}
                          </p>
                          {!!j.skippedTotal && <details><summary>{j.skippedTotal} skipped files</summary><ul>{j.skipped?.map(f=><li key={f.path}><code>{f.path}</code> — {f.reason}</li>)}</ul>{j.skippedTotal > (j.skipped?.length??0) && <p>Showing the first {j.skipped?.length??0} exclusions.</p>}</details>}
                          <progress
                            aria-label={`Indexing ${r.fullName}`}
                            value={j.processed}
                            max={Math.max(1, j.total)}
                          />
                        </div>
                      ),
                  )}
                {r.error && (
                  <p role="alert" className="error">
                    {r.error}
                  </p>
                )}
                {r.knowledgeStatus && (
                  <p className="muted">Knowledge: {r.knowledgeStatus}</p>
                )}
                {r.branches && (
                  <details>
                    <summary>
                      Branches ({r.branches.length}
                      {r.branchesLimited ? "+" : ""})
                    </summary>
                    <ul>
                      {r.branches.map((branch) => (
                        <li key={branch.name}>
                          {branch.name} · {branch.sha.slice(0, 8)}
                          {branch.protected ? " · Protected" : ""}
                        </li>
                      ))}
                    </ul>
                    {r.branchesLimited && (
                      <p className="muted">
                        Showing the first 200 branches. Reviews use the exact PR
                        head commit.
                      </p>
                    )}
                  </details>
                )}
                {r.knowledgeError && (
                  <p role="alert" className="error">
                    Knowledge generation: {r.knowledgeError}
                  </p>
                )}
                <div className="toolbar">
                  {isAdmin && (
                    <>
                      <form action={configureRepository}>
                        <input
                          type="hidden"
                          name="repositoryId"
                          value={r._id}
                        />
                        <input
                          type="hidden"
                          name="enabled"
                          value={String(!r.enabled)}
                        />
                        <button disabled={r.indexStatus === "unavailable"} className={r.enabled ? "" : "primary"}>
                          {r.indexStatus === "unavailable" ? "Indexing unavailable" : r.enabled ? "Disable reviews" : "Enable and index"}
                        </button>
                      </form>
                      <form action={reindex}>
                        <input
                          type="hidden"
                          name="repositoryId"
                          value={r._id}
                        />
                        <button disabled={r.indexStatus === "unavailable"}>Re-index changed files</button>
                      </form>
                      <Link
                        className="button"
                        href={`/dashboard/settings/review?repository=${r._id}`}
                      >
                        Review settings
                      </Link>
                    </>
                  )}
                  <Link href={`/dashboard/memory/knowledge?repository=${r._id}`}>Browse knowledge</Link>
                </div>
              </section>
            ))}
          </>
        )
  );
}
