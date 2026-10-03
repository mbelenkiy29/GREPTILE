import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, humanize, StatusPill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Markdown } from "@/components/ui/Markdown";
import { Table } from "@/components/ui/Table";
import { runDurationMs } from "@/lib/data/lifecycle";
import type { ReviewDetail, ReviewRunItem } from "@/lib/data/reviews";
import type { ReviewSummary } from "@/lib/engine/types";
import { formatCount, formatDate, formatDuration, formatRelative, formatUsd, githubBlobUrl, githubCommitUrl, shortSha } from "@/lib/ui/format";
import { FixWithAiMenu } from "@/components/fix/FixWithAi";
import { FindingCard, verificationNote } from "./FindingCard";
import { RunLifecycle } from "./RunLifecycle";
import { modelLabel } from "./ReviewsTable";

const TRIGGER_LABEL: Record<string, string> = {
  opened: "PR opened",
  synchronize: "New commits",
  reopened: "PR reopened",
  ready_for_review: "Ready for review",
  manual: "Dashboard",
  mention: "@mention",
  api: "API",
  cli: "CLI",
  recovery: "Restart recovery",
};

function SummarySection({ summary, fallback }: { summary: ReviewSummary | null; fallback: string | null }) {
  if (!summary && !fallback) return null;
  return (
    <Card title="Summary" titleId="summary-heading">
      {summary ? (
        <div className="stack-md">
          {summary.overview && <Markdown source={summary.overview} />}
          {summary.whatChanged.length > 0 && (
            <div className="stack-sm">
              <span className="eyebrow">What changed</span>
              <ul className="prose" style={{ margin: 0, paddingLeft: "1.2em" }}>
                {summary.whatChanged.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <dl className="kv">
            <dt>Risk</dt>
            <dd>
              <StatusPill kind="risk" value={summary.riskLevel} /> {summary.riskRationale}
            </dd>
            <dt>Confidence to merge</dt>
            <dd>{summary.confidence}/5</dd>
            {summary.affectedAreas.length > 0 && (
              <>
                <dt>Affected areas</dt>
                <dd>{summary.affectedAreas.join(", ")}</dd>
              </>
            )}
            {summary.architectureImpact && (
              <>
                <dt>Architecture</dt>
                <dd>{summary.architectureImpact}</dd>
              </>
            )}
            {summary.relevantTests.length > 0 && (
              <>
                <dt>Relevant tests</dt>
                <dd>
                  <ul style={{ margin: 0, paddingLeft: "1.1em" }}>
                    {summary.relevantTests.map((t) => (
                      <li key={t.path}>
                        <span className="mono">{t.path}</span> — {t.note}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
        </div>
      ) : (
        <div className="stack-sm">
          <span className="eyebrow">What changed</span>
          <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
            {fallback!.split("\n").filter(Boolean).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function RunHistory({
  runs,
  repoFullName,
  githubUrl,
  now,
  selectedId,
  reviewId,
}: {
  runs: ReviewRunItem[];
  repoFullName: string;
  githubUrl?: string;
  now: Date;
  selectedId: number | undefined;
  reviewId: number;
}) {
  return (
    <Table caption="Run history" compact>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Trigger</th>
          <th scope="col">Status</th>
          <th scope="col">Commit</th>
          <th scope="col" className="num">
            Published
          </th>
          <th scope="col" className="num">
            Rejected
          </th>
          <th scope="col" className="num">
            Resolved
          </th>
          <th scope="col" className="num">
            Tokens
          </th>
          <th scope="col" className="num">
            Cost
          </th>
          <th scope="col">Duration</th>
          <th scope="col">Queued</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} data-run={r.id} aria-current={r.id === selectedId ? "true" : undefined}>
            <td className="mono">
              {r.id === selectedId ? (
                <span className="strong">#{r.id}</span>
              ) : (
                <Link href={`/dashboard/reviews/${reviewId}?run=${r.id}`} aria-label={`Show lifecycle and agents of run ${r.id}`}>
                  #{r.id}
                </Link>
              )}
            </td>
            <td>
              {TRIGGER_LABEL[r.trigger] ?? humanize(r.trigger)}
              <div className="cell-sub">
                {humanize(r.mode ?? "standard")}
                {r.focus ? ` · ${r.focus} focus` : ""}
                {r.full ? " · full" : r.sinceSha ? " · incremental" : ""}
              </div>
            </td>
            <td>
              <StatusPill kind="run" value={r.status} />
              {r.cancelRequested && !["cancelled", "completed", "failed", "superseded", "skipped"].includes(r.status) && (
                <div className="cell-sub">Cancelling…</div>
              )}
            </td>
            <td>
              {r.headSha ? (
                <a className="mono" href={githubCommitUrl(repoFullName, r.headSha, githubUrl)} target="_blank" rel="noreferrer">
                  {shortSha(r.headSha)}
                </a>
              ) : (
                "—"
              )}
              {r.sinceSha && <div className="cell-sub mono">since {shortSha(r.sinceSha)}</div>}
            </td>
            <td className="num">{r.findingsPublished}</td>
            <td className="num">{r.findingsRejected}</td>
            <td className="num">{r.findingsResolved}</td>
            <td className="num">{formatCount(r.inputTokens + r.outputTokens)}</td>
            <td className="num">{formatUsd(r.costUsd)}</td>
            <td className="num nowrap">{formatDuration(runDurationMs(r, now))}</td>
            <td className="nowrap">{formatRelative(r.queuedAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * One pull request review (R1.8, R6.6, R6.13): summary, the latest run's lifecycle, run history, agent runs,
 * published findings, rejected candidates (with stage and reason), and earlier-posted comments.
 */
export function ReviewDetailView({
  review,
  actions,
  githubUrl,
  now = new Date(),
  runId,
  findingActions,
}: {
  review: ReviewDetail;
  /** Per-finding controls, e.g. feedback (R6.10), rendered at the end of each finding card. */
  findingActions?: (f: ReviewDetail["findings"]["items"][number]) => ReactNode;
  /** Run whose lifecycle and agents to show (defaults to the latest; agents must have been loaded for it). */
  runId?: number;
  /** Re-review / cancel controls (rendered by the page). */
  actions?: ReactNode;
  githubUrl?: string;
  now?: Date;
}) {
  const latest = review.runHistory.find((r) => r.id === runId) ?? review.runHistory[0];
  const summary = review.runHistory.find((r) => r.summary)?.summary ?? null;
  return (
    <div className="stack">
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusPill kind="review" value={review.status} />
          </dd>
        </div>
        {review.riskLevel && (
          <div>
            <dt>Risk</dt>
            <dd>
              <StatusPill kind="risk" value={review.riskLevel} />
            </dd>
          </div>
        )}
        {review.confidence !== null && (
          <div>
            <dt>Confidence</dt>
            <dd>Confidence {review.confidence}/5</dd>
          </div>
        )}
        <div>
          <dt>Head</dt>
          <dd className="mono">{shortSha(review.headSha)}</dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>
            {review.openFindings} open · {review.resolvedFindings} resolved
          </dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{review.runs}</dd>
        </div>
        <div>
          <dt>Credits used</dt>
          <dd>{review.creditsUsed}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatUsd(review.costUsd)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {review.usage
              ? `${review.usage.inputTokens.toLocaleString("en-US")} in / ${review.usage.outputTokens.toLocaleString("en-US")} out`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(review.updatedAt)}</dd>
        </div>
      </dl>

      {review.error && <p className="error-text">Last run failed: {review.error}</p>}

      <SummarySection summary={summary} fallback={review.summary} />

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card
          title={latest ? `${latest.id === review.runHistory[0]?.id ? "Latest run" : "Run"} #${latest.id}` : "Lifecycle"}
          titleId="lifecycle-heading"
          description={latest ? `${TRIGGER_LABEL[latest.trigger] ?? humanize(latest.trigger)} · ${modelLabel(latest.models)}` : undefined}
          actions={actions}
        >
          {latest ? (
            <RunLifecycle run={latest} now={now} />
          ) : (
            <p className="dim">This review has no tracked runs yet. Re-review to run it through the pipeline.</p>
          )}
        </Card>
        <Card title="Agents" titleId="agents-heading" description={latest ? `Specialized reviewers in run #${latest.id}` : undefined} flush>
          {review.agentRuns.length ? (
            <Table caption="Agent runs" compact>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">
                    Tokens
                  </th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                  <th scope="col" className="num">
                    Latency
                  </th>
                  <th scope="col" className="num">
                    Candidates
                  </th>
                  <th scope="col" className="num">
                    Accepted
                  </th>
                </tr>
              </thead>
              <tbody>
                {review.agentRuns.map((a) => (
                  <tr key={a.id} data-agent={a.agent}>
                    <td>
                      <div className="row-tight">
                        {humanize(a.agent)} <StatusPill kind="agent" value={a.status} />
                      </div>
                      {a.error && <div className="error-text break">{a.error}</div>}
                    </td>
                    <td className="mono dim">{a.model ?? "—"}</td>
                    <td className="num">{formatCount(a.inputTokens + a.outputTokens)}</td>
                    <td className="num">{formatUsd(a.costUsd)}</td>
                    <td className="num nowrap">{formatDuration(a.latencyMs)}</td>
                    <td className="num">{a.candidates}</td>
                    <td className="num">{a.accepted}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="empty">No agent activity recorded for this run.</p>
          )}
        </Card>
      </div>

      {review.runHistory.length > 0 && (
        <section className="stack-sm" aria-labelledby="runs-heading">
          <h2 id="runs-heading">Run history</h2>
          <RunHistory runs={review.runHistory} repoFullName={review.repoFullName} githubUrl={githubUrl} now={now} selectedId={latest?.id} reviewId={review.id} />
        </section>
      )}

      <section className="stack-md" aria-labelledby="findings-heading">
        <div className="page-head">
          <h2 id="findings-heading">Findings ({review.findings.total})</h2>
          {review.findings.total > review.findings.items.length && (
            <span className="dim">Showing the {review.findings.items.length} most recent</span>
          )}
        </div>
        {review.findings.items.length ? (
          review.findings.items.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              repoFullName={review.repoFullName}
              prNumber={review.prNumber}
              githubUrl={githubUrl}
              actions={<FixWithAiMenu findingId={f.id} />}
              footer={findingActions?.(f)}
            />
          ))
        ) : review.comments.length ? null : (
          <EmptyState icon="check" title="No findings" headingLevel={3}>
            <p>Nothing in this pull request met the confidence and severity thresholds.</p>
          </EmptyState>
        )}
      </section>

      {review.findings.total === 0 && review.comments.length > 0 && (
        <section className="stack-sm" aria-labelledby="comments-heading">
          <h2 id="comments-heading">Inline comments ({review.comments.length})</h2>
          <ul className="comments">
            {review.comments.map((c) => (
              <li key={c.id} className="comment" data-comment={c.id}>
                <div className="row-tight">
                  <StatusPill kind="severity" value={c.severity} />
                  <span className="dim">{c.category}</span>
                  <a className="mono" href={githubBlobUrl(review.repoFullName, c.headSha, c.path, c.line, githubUrl)} rel="noreferrer" target="_blank">
                    {c.path}:{c.line}
                  </a>
                </div>
                <div className="strong">{c.title}</div>
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {review.rejected.total > 0 && (
        <details className="disclosure" data-testid="rejected-candidates">
          <summary>
            Rejected candidates ({review.rejected.total})
            <span className="dim" style={{ fontWeight: 400 }}>
              — raised by an agent, dropped before posting
            </span>
          </summary>
          <div className="disclosure-body">
            <p className="dim">
              Shown for transparency: each candidate below was filtered out by verification, deduplication, or your thresholds, with the
              stage and reason.
            </p>
            <Table caption="Rejected candidates" compact>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Location</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {review.rejected.items.map((f) => {
                  const note = verificationNote(f.verification);
                  return (
                    <tr key={f.id} data-rejected={f.id}>
                      <td>
                        <div className="strong">{f.title}</div>
                        <div className="row-tight" style={{ marginTop: 4 }}>
                          <StatusPill kind="severity" value={f.severity} />
                          <Badge tone="outline">{Math.round(f.confidence * 100)}%</Badge>
                        </div>
                      </td>
                      <td className="mono break">
                        {f.path}:{f.startLine}
                      </td>
                      <td>{humanize(f.agent)}</td>
                      <td>{note.stage ? humanize(note.stage) : "—"}</td>
                      <td className="break">{note.reasons.join("; ") || f.description || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </details>
      )}
    </div>
  );
}
