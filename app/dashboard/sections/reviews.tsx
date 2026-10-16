import { findingSchema } from "../../../src/engine/types";
import { verdictLabels } from "../../../src/verdict";
import Link from "next/link";
import { ReviewMarkdown } from "../markdown";
import { ScrollTable } from "../scroll-table";
import { ReviewError } from "../review-error";

import { MermaidDiagram } from "../mermaid";
import { fixPrompt } from "../../../src/fix-prompt";
import { cancelReview, retryP4Answer, reviewAgain } from "../actions";
import { Copy } from "../live";
import { FixButton } from "../fix-button";
import { PullList } from "../pulls";
import { RuntimeReview, ApprovalReview } from "../runtime";
import { ReviewDiff } from "../review-diff";
import { when, status, priority } from "./shared";
import type { DashboardContext } from "../load";

export function ReviewsSection({ ctx }: { ctx: DashboardContext }) {
  const { data, detail, diagnostics, filters, isAdmin, organization, personalAgent, repoLabel, repoName, user } = ctx;
  return (
          (detail ? (
            <>
              <div className="row">
                <h2>
                  {repoName(detail.review.repositoryId)} #
                  {detail.review.prNumber}
                </h2>
                {status(detail.review.status)}
              </div>
              <p className="muted repository-identity">{repoLabel(detail.review.repositoryId)}</p>
              <p className="muted">
                Reviewed revision {detail.review.headSha} · {when(detail.review.createdAt)}
              </p>
              {detail.latestReviewId && detail.latestReviewId !== detail.review._id && (
                <p role="status">
                  You’re viewing a historical review.{" "}
                  <Link href={`/dashboard/pulls/${detail.latestReviewId}`}>View latest review</Link>
                </p>
              )}
              <p>
                {detail.review.title ?? "Awaiting PR ingestion"} · @
                {detail.review.author ?? "unknown"}
                {detail.review.prUrl && (
                  <>
                    {" "}
                    · <a href={detail.review.prUrl}>View pull request</a>
                  </>
                )}
              </p>
              {detail.review.headBranch && (
                <p className="muted">
                  {detail.review.headBranch} → {detail.review.baseBranch}
                </p>
              )}
              <ReviewDiff token={user.token} reviewId={detail.review._id} open={filters.diff === "1"} finished={["completed", "failed", "cancelled"].includes(detail.review.status)} findings={detail.findings.map((f) => ({ _id: String(f._id), title: f.title, severity: f.severity, filePath: f.filePath, startLine: f.startLine, endLine: f.endLine, description: f.description }))} />
              <p className="muted">
                Started {when(detail.review.createdAt)} · {detail.review.status === "cancelled" ? "Cancelled" : "Finished"}{" "}
                {detail.review.finishedAt
                  ? when(detail.review.finishedAt)
                  : ["completed","failed","cancelled"].includes(detail.review.status) ? "Time not recorded" : "In progress"}{" "}
                · Models: {detail.review.models || [...new Set(detail.modelCalls.map(call => call.model))].join(", ") || "Not called yet"}
              </p>
              {detail.review.error && (
                <ReviewError error={detail.review.error} alert/>
              )}
              {detail.retryPending&&<p role="status">Retry {detail.review.retryAt ? "scheduled for "+when(detail.review.retryAt) : "pending"}. The review will update automatically.</p>}
              <RuntimeReview token={user.token} reviewId={detail.review._id} evidence={detail.review.runtimeEvidence}/>{detail.review.nativeP4?<p>Automatic approval is not available for Perforce reviews.</p>:<ApprovalReview token={user.token} reviewId={detail.review._id}/>}
              {detail.review.modeDecision && <p className="muted">Review tier: <strong>{detail.review.modeDecision.mode}</strong> ({detail.review.modeDecision.source === "settings" ? "configured" : `requested by ${detail.review.modeDecision.source}`}{detail.review.modeDecision.capped ? `; ${detail.review.modeDecision.requested} was capped by the workspace limit` : ""})</p>}
              {detail.review.aiAuthored && <p role="note">Written by a coding agent: <strong>{detail.review.aiAuthored.agent}</strong> ({detail.review.aiAuthored.detail}){detail.review.aiAuthored.model ? <> · reviewed with <code>{detail.review.aiAuthored.model}</code></> : null}</p>}
              {detail.review.verdict && <section aria-label="Verdict"><h2>Verdict</h2><p><strong>{verdictLabels[detail.review.verdict]}</strong> · computed from the score, unresolved findings and review coverage</p></section>}
              <section aria-label="Confidence score">
                <h2>Confidence score</h2>
                {detail.review.reviewScore ? <><p><strong>{detail.review.reviewScore.value}/5</strong> · confidence that the change is safe to merge</p><p>{detail.review.reviewScore.reason}</p></> : <p className="muted">Not recorded for this review.</p>}
              </section>
              {detail.review.approvalAssessment && (
                <section>
                  <h2>Approval assessment</h2>
                  <p>Risk: {detail.review.approvalAssessment.risk} · Confidence: {Math.round(detail.review.approvalAssessment.confidence*100)}%</p>
                  <p>{detail.review.approvalAssessment.reason}</p>
                  <p className="muted">Approval requires the configured policy and current provider checks.</p>
                  {detail.review.coverageLimits?.map(limit=><p key={limit}>{limit}</p>)}
                </section>
              )}
              <section aria-label="Review history">
                <h2>Review history</h2>
                <ol className="timeline">
                  {detail.history.page.map(r => <li key={r._id}>
                    <Link href={`/dashboard/pulls/${r._id}`} aria-current={r._id === detail.review._id ? "page" : undefined}>
                      {when(r.createdAt)} · {r.headSha} · {r.status.replaceAll("_", " ")}
                    </Link>
                    <span>{r.findingCount ?? "Pending"} findings · Score {r.reviewScore ? `${r.reviewScore.value}/5` : "not recorded"}</span>
                  </li>)}
                </ol>
                {!detail.history.isDone && <Link href={`/dashboard/pulls/${detail.review._id}?historyCursor=${encodeURIComponent(detail.history.continueCursor)}`}>Older reviews</Link>}
                {filters.historyCursor && <Link href={`/dashboard/pulls/${detail.review._id}`}>Latest reviews</Link>}
              </section>
              <section>
                <h2>Processing lifecycle</h2>
                <ol className="timeline">
                  {detail.runs.map((r) => (
                    <li key={r._id}>
                      <strong>{r.stage.replaceAll("_", " ")}</strong>
                      <span>
                        {when(r.createdAt)} {r.detail}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
              {!["completed", "failed", "cancelled"].includes(
                detail.review.status,
              ) && (
                <form action={cancelReview}>
                  <input
                    type="hidden"
                    name="reviewId"
                    value={detail.review._id}
                  />
                  <button>Cancel review</button>
                </form>
              )}
              <section>
                <div className="row"><h2>Review summary</h2>{detail.review.nativeP4&&isAdmin&&detail.review.status==="failed"&&detail.review.resultStorageId&&<form action={reviewAgain}><input type="hidden" name="reviewId" value={detail.review._id}/><input type="hidden" name="fresh" value="true"/><button>Re-review current shelf</button></form>}{(!detail.review.nativeP4||isAdmin)&&<form action={reviewAgain}><input type="hidden" name="reviewId" value={detail.review._id}/><button>{detail.review.nativeP4?(detail.review.status==="failed"&&detail.review.resultStorageId?"Retry saved publication":"Re-review current shelf"):"Re-review current PR"}</button></form>}</div>
                <ReviewMarkdown>
                  {detail.review.summary ??
                    (detail.review.status === "failed" ? "No summary was generated. Review the error above before retrying." : detail.review.status === "cancelled" ? "This review was cancelled before a summary was generated." : "The summary will appear when analysis finishes.")}
                </ReviewMarkdown>
              </section>
              {detail.review.nativeP4&&<section aria-label="Native follow-up answers"><h2>Native follow-up answers</h2><p>Questions mentioning @openreview are discovered while native polling is enabled. Authors must link their native identity in Personal agents. Answers use the permitted sources of each author; they do not resolve findings or establish test execution.</p>{!detail.nativeConversations.length&&<p>No native questions recorded for this review.</p>}{detail.nativeConversations.map(answer=><article key={answer.id}><p><strong>@{answer.author}</strong> · {answer.status} · {answer.attempts} {answer.attempts===1?"attempt":"attempts"} · {when(answer.updatedAt)}</p><p>{answer.question}</p>{answer.error&&<p role="alert">{answer.error}</p>}{answer.answer&&<details><summary>{answer.status==="completed"?"Published answer":"Saved answer; publication not complete"}</summary><ReviewMarkdown>{answer.answer}</ReviewMarkdown></details>}{answer.replyId&&<p>Native reply #{answer.replyId}</p>}{answer.command?.requestedReviewId&&<p><a href={"/dashboard/pulls/"+answer.command.requestedReviewId}>View requested re-review</a></p>}{answer.canRetry&&<form action={retryP4Answer}><input type="hidden" name="conversationId" value={answer.id}/><button>Retry native answer</button></form>}</article>)}{detail.nativeConversationsTruncated&&<p className="muted">Showing the latest 20 native questions.</p>}</section>}
              {diagnostics&&diagnostics.diagrams.length>0&&<section aria-label="Sequence diagram"><h2>Sequence diagram</h2><MermaidDiagram code={diagnostics.diagrams[0]}/></section>}
              {diagnostics&&<section aria-label="Review diagnostics"><h2>Review diagnostics</h2>{diagnostics.coverageLimits.map(limit=><p key={limit}>{limit}</p>)}{diagnostics.failedSpecialists.length>0&&<><h3>Failed specialists</h3><ul>{diagnostics.failedSpecialists.map(f=><li key={f.category}><strong>{f.category}</strong><p>{f.error}</p></li>)}</ul></>}{diagnostics.skippedFiles.length>0&&<><h3>Skipped files</h3><ul aria-label="Skipped files">{diagnostics.skippedFiles.slice(0,200).map((f,i)=><li key={i}><code>{f.path}</code> · {f.reason}</li>)}</ul>{diagnostics.skippedFiles.length>200&&<p>{diagnostics.skippedFiles.length-200} more skipped files not shown.</p>}</>}{diagnostics.agentBudget&&<p>Agent budget: {diagnostics.agentBudget.turns} turns and {diagnostics.agentBudget.toolCalls} tool calls{diagnostics.agentBudget.perHypothesis?" per hypothesis":""}</p>}{diagnostics.hypotheses.length>0&&<><h3>Hypotheses investigated</h3><ScrollTable label="Hypotheses table"><table><thead><tr><th>#</th><th>Hypothesis</th><th>Location</th><th>Status</th><th>Tool calls</th><th>Reported</th></tr></thead><tbody>{diagnostics.hypotheses.map(h=><tr key={h.id}><td>{h.id}</td><td>{h.claim}</td><td><code>{h.filePath}:{h.startLine}</code></td><td>{h.status}{h.stopReason&&h.status!=="completed"?" · "+h.stopReason:""}</td><td>{h.toolCalls}</td><td>{h.reported}</td></tr>)}</tbody></table></ScrollTable></>}<h3>Suppressed candidates</h3>{diagnostics.suppressions.length?<ul>{diagnostics.suppressions.map((s,i)=><li key={i}><strong>{s.title}</strong> · {s.agent}<p>{s.reason}</p></li>)}</ul>:<p>No suppressed candidates.</p>}</section>}
              {!detail.historicalFindingsAvailable && detail.review.resultStorageId && <p role="status">Historical finding snapshots are unavailable for this review. An administrator can recover them from the saved review result.</p>}
              {detail.findings.length > 0 && (
                <section>
                  <h2>Verified findings</h2>
                  {detail.canFix && <FixButton reviewId={detail.review._id} agent={personalAgent} label="Fix All" />}
                  {detail.canFix && <Copy
                    value={fixPrompt(
                      repoName(detail.review.repositoryId),
                      `PR #${detail.review.prNumber}`,
                      detail.findings
                        .filter(
                          (finding) =>
                            finding.canFix,
                        )
                        .map((finding) => ({
                          ...findingSchema.parse(finding),
                          agent: finding.agent,
                          fingerprint: finding.fingerprint,
                          commitSha: finding.commitSha,
                        })),
                      detail.review.runtimeEvidence,
                    )}
                    label="Copy Fix All prompt"
                  />}
                  {detail.findings.map((finding) => (
                    <article key={finding._id}>
                      <h3>
                        {priority(finding)} {finding.title}
                      </h3>
                      <p>
                        {finding.filePath}:{finding.startLine} ·{" "}
                        {finding.outsideDiff && <>Outside the changed code (summary only, not posted inline) ·{" "}</>}
                        {Math.round(finding.confidence * 100)}% confidence ·{" "}
                        Verified at this revision · Current status: {finding.currentStatus}
                      </p>
                      <p>{finding.description}</p>
                      {finding.question && <p><strong>Question for the author:</strong> {finding.question}</p>}
                      {finding.generatedTest && <details><summary>Generated test: {finding.generatedTest.status}{finding.generatedTest.exitCode !== undefined && finding.generatedTest.exitCode !== null ? ` (exit ${finding.generatedTest.exitCode})` : ""} · never committed</summary><p><code>{finding.generatedTest.command}</code></p><pre>{finding.generatedTest.path}{"\n"}{finding.generatedTest.code}</pre><pre>{finding.generatedTest.output || "(no output)"}</pre></details>}
                      <p>Impact: {finding.impact}</p>
                      {finding.evidence.map((e, index) => (
                        <div key={index}>{e.sourceUrl&&<a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.repository} · {e.revision?.slice(0,8)} · source</a>}<pre>{e.filePath}:{e.startLine}{"\n"}{e.quote}</pre></div>
                      ))}
                      <p>Suggested fix: {finding.suggestedFix}</p>
                      {finding.canFix && <FixButton reviewId={detail.review._id} agent={personalAgent} findingId={finding._id} />}
                    </article>
                  ))}
                </section>
              )}
              <h2>Model calls</h2>
              <ScrollTable label="Model calls table">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Model</th>
                      <th>Tokens</th>
                      <th>Duration</th>
                      <th>Cost</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.modelCalls.map((c) => (
                      <tr key={c._id}>
                        <td>{c.task}</td>
                        <td>{c.model}</td>
                        <td>{c.inputTokens + c.outputTokens}</td>
                        <td>{(c.latencyMs / 1000).toFixed(1)}s</td>
                        <td>${c.estimatedCost.toFixed(4)}</td>
                        <td>
                          {c.error ? <ReviewError error={c.error}/> : c.cached ? "Cached" : "Completed"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            </>
          ) : (
            <>
              <PullList admin={isAdmin} token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters} />
            </>
          ))
  );
}
