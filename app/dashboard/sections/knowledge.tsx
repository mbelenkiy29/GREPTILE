import { repositoryDisplay, providerDisplay } from "../../../src/provider-display";
import Link from "next/link";
import { Empty } from "./shared";
import type { DashboardContext } from "../load";

export function KnowledgeSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, knowledge, knowledgeState, requestedRepository } = ctx;
  return (
(
          <>
            <form className="filter-bar">
              {filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}
              <label>Repository<select name="repository" defaultValue={requestedRepository??""}><option value="">All accessible repositories</option>{data.repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select></label>
              <label>Search knowledge<input name="q" defaultValue={filters.q} maxLength={200}/></label>
              <button>Apply</button>
            </form>
            {knowledgeState.searchError && <p role="alert">Search must contain at most 200 characters. Shorten it and apply the filters again.</p>}
            {!knowledgeState.searchError && <p className="muted">{knowledgeState.count} matching entries{knowledgeState.incomplete ? " from repositories successfully loaded · Results are incomplete." : ""} · Search covers subsystems, descriptions, files, dependencies, risks and conventions. Related findings show the latest 100 findings per repository.</p>}
            {knowledge.filter(k=>k.failed).map(k=><section key={k.repo._id}><h2>{k.repo.fullName}</h2><p className="muted repository-identity">{providerDisplay(k.repo.provider)}</p><p role="alert">Knowledge could not be loaded. Retry the request; if access changed, choose an accessible repository.</p><a className="button" href={knowledgeState.retryUrl}>Retry knowledge</a></section>)}
            {knowledgeState.empty && (
              <Empty
                title={filters.q || requestedRepository ? "No matching knowledge" : "Repository knowledge"}
                text={filters.q || requestedRepository ? "Adjust the search or repository filter. Knowledge is generated after repository indexing." : "Codebase knowledge is generated after indexing. Enable a repository to begin."}
              />
            )}
            {knowledge.flatMap((k) =>
              k.entries.map((e) => (
                <section key={e._id}>
                  <p className="muted">
                    {repositoryDisplay(k.repo)} · <code>{e.sha}</code>
                  </p>
                  <h2>{e.subsystem}</h2>
                  <p>{e.description}</p>
                  <p className="muted">
                    Dependencies: {e.dependencies.join(", ") || "None recorded"}{" "}
                    · Risks: {e.risks.join("; ") || "None recorded"}
                  </p>
                  {e.pastFindings.length > 0 && (
                    <ul>
                      {e.pastFindings.map((finding) => (
                        <li key={finding.id}>
                          <Link href={`/dashboard/reviews/${finding.reviewId}`}>
                            {finding.title}
                          </Link>{" "}
                          · PR #{finding.prNumber} · {finding.status}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details>
                    <summary>Related files and conventions</summary>
                    <ul>{e.sources.map(source => <li key={source.path}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.path}</a> : <>{source.path} <span className="muted">· Source link unavailable</span></>}</li>)}</ul>
                    <pre>{e.conventions.join("\n")}</pre>
                  </details>
                </section>
              )),
            )}
          </>
        )
  );
}
