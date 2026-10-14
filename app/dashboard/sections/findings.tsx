import { findingSchema } from "../../../src/engine/types";
import { repositoryDisplay } from "../../../src/provider-display";
import Link from "next/link";

import { fixPrompt } from "../../../src/fix-prompt";
import { feedback } from "../actions";
import { Copy } from "../live";
import { FixButton } from "../fix-button";
import { AgentLinks } from "../agent-links";
import { status, priority, Empty } from "./shared";
import type { DashboardContext } from "../load";

export function FindingsSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, findingsPage, personalAgent, repoName, visibleFindings } = ctx;
  return (
(
          <>
            <form method="get" className="toolbar">
              {filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}
              <label>
                Repository
                <select
                  name="repository"
                  defaultValue={filters.repository ?? ""}
                >
                  <option value="">All repositories</option>
                  {data.repositories.map((r) => (
                    <option key={r._id} value={r._id}>
                      {repositoryDisplay(r)}
                    </option>
                  ))}
                </select>
              </label>
              {[
                ["severity", ["critical", "high", "medium", "low"]],
                [
                  "category",
                  [
                    "correctness",
                    "security",
                    "data",
                    "compatibility",
                    "testing",
                    "performance",
                    "rules",
                  ],
                ],
                ["status", ["open", "resolved", "wont_fix", "false_positive"]],
                ["usefulness", ["useful", "not_useful", "false_positive"]],
              ].map(([key, options]) => (
                <label key={String(key)}>
                  {String(key)}
                  <select
                    name={String(key)}
                    defaultValue={filters[String(key)] ?? ""}
                  >
                    <option value="">All</option>
                    {(options as string[]).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                PR author
                <input name="author" defaultValue={filters.author ?? ""} />
              </label>
              <label>
                Since
                <input
                  name="since"
                  type="date"
                  defaultValue={filters.since ?? ""}
                />
              </label>
              <button>Filter findings</button>
              <Link href="/dashboard/findings">Reset filters</Link>
            </form>
            {!visibleFindings.length && (
              <Empty
                title="No findings yet"
                text="Open a pull request in an enabled repository. Verified findings will appear here."
              />
            )}
            {visibleFindings.some((f) => f.canFix) && (
              <Copy
                label="Copy eligible tasks on this page"
                value={visibleFindings
                    .filter((f) => f.canFix)
                    .map((f) => fixPrompt(repoName(f.repositoryId), `PR #${f.prNumber}`, [{
                      ...findingSchema.parse(f),
                      agent: f.agent,
                      fingerprint: f.fingerprint,
                      commitSha: f.commitSha,
                    }]))
                    .join("\n\n--- Next finding task: use its named repository, PR and revision ---\n\n")}
              />
            )}
            {visibleFindings.map((f) => {
              const prompt = fixPrompt(
                repoName(f.repositoryId),
                `PR #${f.prNumber}`,
                [
                  {
                    ...findingSchema.parse(f),
                    agent: f.agent,
                    fingerprint: f.fingerprint,
                    commitSha: f.commitSha,
                  },
                ],
              );
              return (
                <section className="finding" key={f._id}>
                  <div className="row">
                    <h2>{f.title}</h2>
                    <div>
                      {priority(f)} {status(f.status)}
                    </div>
                  </div>
                  <p className="muted">
                    {repoName(f.repositoryId)} #{f.prNumber} · {f.filePath}:
                    {f.startLine} · {Math.round(f.confidence * 100)}% confidence
                  </p>
                  <p>{f.description}</p>
                  {f.ruleId && (
                    <p className="muted">
                      Rule:{" "}
                      {data.rules.find((rule) => rule._id === f.ruleId)
                        ?.title ?? f.ruleId}
                    </p>
                  )}
                  <p>
                    <strong>Impact:</strong> {f.impact}
                  </p>
                  {f.evidence.map((e, i) => (
                    <div key={i}>
                      {e.sourceUrl&&<a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.repository} · {e.revision?.slice(0,8)} · source</a>}
                      <p className="muted">
                        {e.filePath}:{e.startLine}
                      </p>
                      <pre>
                        <code>{e.quote}</code>
                      </pre>
                    </div>
                  ))}
                  <p>
                    <strong>Suggested fix:</strong> {f.suggestedFix}
                  </p>
                  {f.canFix && <FixButton reviewId={f.reviewId} agent={personalAgent} findingId={f._id} />}
                  {f.status === "open" && !f.canFix && data.writableRepositoryIds.includes(f.repositoryId) && <p className="muted">Fix requires this finding to belong to the latest completed review, meet the current confidence threshold, and have current repository access.</p>}
                  <Copy value={prompt} />
                  <AgentLinks prompt={prompt} repo={data.repositories.find((r) => r._id === f.repositoryId)} />
                  <details>
                    <summary>
                      Portable prompt for Codex, Claude Code, or Cursor
                    </summary>
                    <pre>{prompt}</pre>
                  </details>
                  {data.writableRepositoryIds.includes(f.repositoryId) && <form action={feedback} className="feedback">
                    <input type="hidden" name="findingId" value={f._id} />
                    <label>
                      Feedback
                      <select name="value">
                        <option value="useful">Useful</option>
                        <option value="not_useful">Not useful</option>
                        <option value="resolved">Resolved</option>
                        <option value="wont_fix">Won’t fix</option>
                        <option value="false_positive">False positive</option>
                      </select>
                    </label>
                    <label>
                      Reason
                      <input name="comment" maxLength={5000} />
                    </label>
                    <button>Save feedback</button>
                  </form>}
                </section>
              );
            })}
            {findingsPage && !findingsPage.isDone && (
              <Link
                className="button"
                href={`/dashboard/findings?${new URLSearchParams(Object.entries({ ...filters, cursor: findingsPage.continueCursor }).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString()}`}
              >
                Next findings
              </Link>
            )}
          </>
        )
  );
}
