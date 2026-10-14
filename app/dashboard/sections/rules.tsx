import { repositoryDisplay } from "../../../src/provider-display";
import Link from "next/link";
import { saveRule } from "../actions";
import { status, Empty } from "./shared";
import type { DashboardContext } from "../load";

export function RulesSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, isAdmin, organization, repoName, requestedRepository, rulesPage, selectedTeam, visibleRules } = ctx;
  return (
(
          <>
            <form className="toolbar" method="get" action="/dashboard/memory/rules">
              {selectedTeam&&<input type="hidden" name="team" value={selectedTeam._id}/>}
              <label>Rules for repository<select name="repository" defaultValue={requestedRepository??""}>
                <option value="">All accessible repositories</option>
                {data.repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}
              </select></label><button>Apply filter</button>
            </form>
            {requestedRepository&&<p>Workspace rules are inherited by this repository. Disabled rules remain visible for management but do not run in reviews.</p>}
            {isAdmin && (
              <section>
                <h2>Add a review rule</h2>
                <form action={saveRule} className="form-grid">
                  <input
                    type="hidden"
                    name="organizationId"
                    value={organization._id}
                  />
                  <label>
                    Title
                    <input name="title" required />
                  </label>
                  <label>
                    Repository scope
                    <select name="repositoryId" defaultValue={requestedRepository??""}>
                      <option value="">Entire workspace</option>
                      {data.repositories.map((r) => (
                        <option key={r._id} value={r._id}>
                          {repositoryDisplay(r)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wide">
                    Instructions
                    <textarea name="instructions" rows={3} required />
                  </label>
                  <label>
                    Severity
                    <select name="severity">
                      <option>medium</option>
                      <option>high</option>
                      <option>critical</option>
                      <option>low</option>
                    </select>
                  </label>
                  <label>
                    File globs (comma separated)
                    <input name="globs" />
                  </label>
                  <button className="primary">Create rule</button>
                </form>
              </section>
            )}
            {!visibleRules.length && (
              <Empty
                title="Your codebase, your conventions"
                text="Add specific rules such as requiring organization membership validation in API endpoints."
              />
            )}
            {visibleRules.map((r) => (
              <section key={r._id}>
                <h2>
                  {r.title} {status(r.enabled ? "enabled" : "disabled")}
                </h2>
                <p>{r.instructions}</p>
                <p className="muted">
                  {r.repositoryId ? repoName(r.repositoryId) : "Workspace"} ·{" "}
                  {r.severity}
                  {!r.repositoryId&&<span className="badge">{requestedRepository?"Inherited from workspace":"Workspace default"}</span>}
                </p>
                {isAdmin && (
                  <details>
                    <summary>Edit rule</summary>
                    <form action={saveRule} className="form-grid" key={JSON.stringify(r)}>
                      <input
                        type="hidden"
                        name="organizationId"
                        value={organization._id}
                      />
                      <input type="hidden" name="id" value={r._id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={String(r.enabled)}
                      />
                      <label>
                        Title
                        <input name="title" required defaultValue={r.title} />
                      </label>
                      <label>
                        Repository scope
                        <select
                          name="repositoryId"
                          defaultValue={r.repositoryId ?? ""}
                        >
                          <option value="">Workspace</option>
                          {data.repositories.map((repo) => (
                            <option key={repo._id} value={repo._id}>
                              {repositoryDisplay(repo)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="wide">
                        Instructions
                        <textarea
                          name="instructions"
                          required
                          defaultValue={r.instructions}
                        />
                      </label>
                      <label>
                        Severity
                        <select name="severity" defaultValue={r.severity}>
                          {["critical", "high", "medium", "low"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Globs
                        <input name="globs" defaultValue={r.globs.join(",")} />
                      </label>
                      <input type="hidden" name="category" value={r.category} />
                      <button>Save rule</button>
                    </form>
                  </details>
                )}
                {isAdmin && (
                  <form action={saveRule}>
                    <input
                      type="hidden"
                      name="organizationId"
                      value={organization._id}
                    />
                    <input type="hidden" name="id" value={r._id} />
                    <input type="hidden" name="title" value={r.title} />
                    <input
                      type="hidden"
                      name="instructions"
                      value={r.instructions}
                    />
                    <input type="hidden" name="severity" value={r.severity} />
                    <input
                      type="hidden"
                      name="repositoryId"
                      value={r.repositoryId ?? ""}
                    />
                    <input
                      type="hidden"
                      name="globs"
                      value={r.globs.join(",")}
                    />
                    <input type="hidden" name="category" value={r.category} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={String(!r.enabled)}
                    />
                    <button>
                      {r.enabled ? "Disable rule" : "Enable rule"}
                    </button>
                    <button name="remove" value="true">
                      Delete rule
                    </button>
                  </form>
                )}
              </section>
            ))}
            {rulesPage&&<nav className="toolbar" aria-label="Rules pagination">
              {filters.cursor&&<Link href={`/dashboard/memory/rules?${new URLSearchParams({...requestedRepository?{repository:requestedRepository}:{},...selectedTeam?{team:selectedTeam._id}:{}})}`}>Newest rules</Link>}
              {!rulesPage.isDone&&<Link href={`/dashboard/memory/rules?${new URLSearchParams({cursor:rulesPage.continueCursor,...requestedRepository?{repository:requestedRepository}:{},...selectedTeam?{team:selectedTeam._id}:{}})}`}>Older rules</Link>}
              <p className="muted">{visibleRules.length} rules on this page{rulesPage.isDone?" · End of rules":""}.</p>
            </nav>}
          </>
        )
  );
}
