import Link from "next/link";
import { Badge, StatusPill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { BarChart, Sparkline } from "@/components/ui/Chart";
import { EmptyState } from "@/components/ui/EmptyState";
import { Stat } from "@/components/ui/Stat";
import type { Overview } from "@/lib/data/overview";
import { formatCount, formatPercent, formatRelative, formatUsd } from "@/lib/ui/format";
import { IndexStatus } from "./IndexStatus";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--crit-bg)",
  high: "var(--bad-solid)",
  medium: "var(--warn-solid)",
  low: "var(--muted-solid)",
};

/** First-run state: nothing connected yet. Admins get the install action; everyone gets onboarding. */
export function OverviewEmpty({ canInstall }: { canInstall: boolean }) {
  return (
    <EmptyState
      icon="repo"
      title="Connect your first repository"
      actions={
        <>
          {canInstall && (
            <ButtonLink href="/api/github/install" variant="primary" icon="github">
              Install the GitHub App
            </ButtonLink>
          )}
          <ButtonLink href="/onboarding">Start onboarding</ButtonLink>
        </>
      }
    >
      <p>
        OpenReview reviews pull requests with your whole codebase in view. Install the GitHub App on an account, pick repositories,
        and the first review lands on your next pull request.
      </p>
      {!canInstall && <p>Only owners and admins can install the GitHub App. Ask one of them, or follow onboarding to see what&apos;s involved.</p>}
    </EmptyState>
  );
}

/** The dashboard home (R6.13): KPIs, findings by severity, feedback, activity, indexing, usage, and recent reviews. */
export function OverviewView({ overview: o, now = new Date() }: { overview: Overview; now?: Date }) {
  const points = o.activity.map((d) => ({ label: d.day, value: d.runs }));
  const runs30 = o.activity.reduce((n, d) => n + d.runs, 0);
  const sevMax = Math.max(1, ...o.bySeverity.map((s) => s.count));
  const fb = o.feedback;
  return (
    <div className="stack" data-testid="overview">
      <div className="grid-kpi">
        <Stat label="Repositories" value={formatCount(o.counts.repos)} hint={`${formatCount(o.counts.activeRepos)} with reviews on`} />
        <Stat
          label="PRs reviewed"
          value={formatCount(o.counts.prsReviewed)}
          hint={`${formatCount(runs30)} runs in 30 days`}
          chart={<Sparkline points={points} label="Review runs per day, last 30 days" />}
        />
        <Stat label="Findings caught" value={formatCount(o.counts.findingsCaught)} hint="Published to pull requests" />
        <Stat
          label="Acceptance"
          value={formatPercent(fb.acceptanceRate)}
          hint={fb.acceptanceRate === null ? "No feedback yet" : `${fb.useful} useful · ${fb.notUseful} not useful · ${fb.falsePositive} false positive`}
        />
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card title="Review activity" titleId="activity-heading" description="Review runs per day, last 30 days (UTC)">
          <BarChart points={points} height={96} label="Review runs per day, last 30 days" unit="runs" />
          <div className="row dim" style={{ justifyContent: "space-between" }}>
            <span>{points[0]?.label}</span>
            <span>{points[points.length - 1]?.label}</span>
          </div>
        </Card>
        <Card title="Findings by severity" titleId="severity-heading" actions={<Link href="/dashboard/findings">All findings</Link>}>
          <div className="severity-bars">
            {o.bySeverity.map((s) => (
              <div key={s.severity} className="severity-bar" data-severity={s.severity}>
                <StatusPill kind="severity" value={s.severity} />
                <span className="severity-track" aria-hidden="true">
                  <span style={{ width: `${(s.count / sevMax) * 100}%`, background: SEVERITY_COLOR[s.severity] }} />
                </span>
                <Link className="num" href={`/dashboard/findings?severity=${s.severity}`} aria-label={`${s.count} ${s.severity} findings`}>
                  {formatCount(s.count)}
                </Link>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card title="Repositories" titleId="index-heading" description="Index state; in-progress runs update live" actions={<Link href="/dashboard/repos">Manage</Link>} flush>
          <ul className="comments" style={{ padding: "var(--space-3) var(--space-4)", gap: "var(--space-3)" }}>
            {o.indexing.map((r) => (
              <li key={r.repoId} className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }} data-repo={r.fullName}>
                <Link href={`/dashboard/repos/${r.repoId}`} className="cell-title truncate" style={{ maxWidth: "50%" }}>
                  {r.fullName}
                </Link>
                <IndexStatus status={r.indexStatus} error={r.indexError} job={r.job} repoName={r.fullName} />
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Usage this month" titleId="usage-heading" description={`Since ${o.usage.since.toISOString().slice(0, 10)} (UTC)`} actions={<Link href="/dashboard/usage">Details</Link>}>
          <dl className="kv">
            <dt>Reviews</dt>
            <dd className="num">{formatCount(o.usage.reviews)}</dd>
            <dt>Tokens</dt>
            <dd className="num">
              {formatCount(o.usage.inputTokens + o.usage.outputTokens)}{" "}
              <span className="dim">
                ({formatCount(o.usage.inputTokens)} in / {formatCount(o.usage.outputTokens)} out)
              </span>
            </dd>
            <dt>Estimated cost</dt>
            <dd className="num">{formatUsd(o.usage.costUsd)}</dd>
            <dt>Credits</dt>
            <dd className="num">{formatCount(o.usage.credits)}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Recent reviews" titleId="recent-heading" actions={<Link href="/dashboard/reviews">All reviews</Link>} flush>
        {o.recentReviews.length ? (
          <ul className="comments" style={{ padding: "var(--space-3) var(--space-4)" }}>
            {o.recentReviews.map((r) => (
              <li key={r.id} className="row" style={{ justifyContent: "space-between" }} data-review={r.id}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Link className="cell-title" href={`/dashboard/reviews/${r.id}`}>
                    {r.repoFullName}#{r.prNumber}
                  </Link>
                  <div className="cell-sub truncate">
                    {r.prTitle || "Untitled"}
                    {r.prAuthor && <> · @{r.prAuthor}</>}
                  </div>
                </div>
                <div className="row-tight">
                  {r.openFindings > 0 && <Badge tone="info">{r.openFindings} open</Badge>}
                  <StatusPill kind="review" value={r.status} />
                  <span className="dim nowrap">{formatRelative(r.updatedAt, now)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No reviews yet. Open a pull request on a connected repository to get the first one.</p>
        )}
      </Card>
    </div>
  );
}
