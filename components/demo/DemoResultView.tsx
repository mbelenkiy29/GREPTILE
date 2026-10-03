import Link from "next/link";
import { Badge, ConfidencePill, humanize, StatusPill } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { CodeBlock } from "@/components/ui/Code";
import { Icon } from "@/components/ui/icons";
import { Markdown } from "@/components/ui/Markdown";
import type { DemoReviewView } from "@/lib/demo/view";

const STATUS_TEXT: Record<DemoReviewView["status"], string> = {
  queued: "Waiting for a reviewer to pick this up…",
  running: "Indexing the repository and reviewing the change. This usually takes a minute or two.",
  completed: "Review complete.",
  failed: "The review did not finish.",
  rejected: "This pull request can't be reviewed in the demo.",
};

/**
 * A demo review (R3.7): status while it runs, then the summary and the findings with the code they point at. All
 * model-written text is rendered as safe Markdown or plain text. Always labeled as a demo that was not posted.
 */
export function DemoResultView({ review }: { review: DemoReviewView }) {
  const { pr, result } = review;
  const active = review.status === "queued" || review.status === "running";
  return (
    <div className="stack" data-demo-status={review.status}>
      <Alert tone="neutral" title="Demo review — not posted to the pull request">
        This review ran on the public demo in fast mode. Nothing was written to GitHub, and the result is deleted after a day.
      </Alert>
      <div className="stack-sm">
        <span className="eyebrow">
          {pr.owner}/{pr.repo} #{pr.number}
        </span>
        <h1>{pr.title ?? `Pull request #${pr.number}`}</h1>
        <div className="row-tight dim">
          {pr.author && <span>@{pr.author}</span>}
          {pr.headSha && <span className="mono">{pr.headSha.slice(0, 7)}</span>}
          <a href={pr.url} target="_blank" rel="noreferrer noopener">
            View on GitHub <Icon name="external" size={12} />
          </a>
        </div>
      </div>

      <div className="row-tight" role="status">
        <StatusPill kind="job" value={review.status === "rejected" ? "failed" : review.status} label={humanize(review.status)} />
        <span className={active ? "dim" : undefined}>{STATUS_TEXT[review.status]}</span>
      </div>
      {review.reason && (review.status === "failed" || review.status === "rejected") && <Alert tone={review.status === "failed" ? "error" : "warning"}>{review.reason}</Alert>}

      {result && (
        <>
          <section className="card" aria-labelledby="demo-summary">
            <div className="card-body stack-md">
              <div className="row-tight">
                <h2 id="demo-summary">Summary</h2>
                <StatusPill kind="risk" value={result.summary.riskLevel} label={`${humanize(result.summary.riskLevel)} risk`} />
                <Badge tone="outline">Confidence {result.summary.confidence}/5</Badge>
              </div>
              {result.summary.overview && <Markdown source={result.summary.overview} />}
              {result.summary.whatChanged.length > 0 && (
                <ul className="prose" style={{ margin: 0, paddingLeft: "1.2em" }}>
                  {result.summary.whatChanged.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              {result.summary.riskRationale && <p className="dim">{result.summary.riskRationale}</p>}
            </div>
          </section>

          <section className="stack-md" aria-labelledby="demo-findings">
            <h2 id="demo-findings">
              Findings ({result.findings.length}) <span className="dim">· {result.filesReviewed} files reviewed</span>
            </h2>
            {result.findings.length === 0 && <p className="empty">No issues found in this change.</p>}
            {result.findings.map((f, i) => (
              <article key={`${f.path}:${f.startLine}:${i}`} className="finding" data-severity={f.severity} aria-labelledby={`demo-finding-${i}`}>
                <div className="row-tight">
                  <StatusPill kind="severity" value={f.severity} />
                  <ConfidencePill value={f.confidence} />
                  <Badge tone="outline">{humanize(f.category)}</Badge>
                </div>
                <h3 className="finding-title" id={`demo-finding-${i}`}>
                  {f.title}
                </h3>
                <span className="mono dim break">
                  {f.path}:{f.startLine}
                  {f.endLine > f.startLine ? `–${f.endLine}` : ""}
                </span>
                <Markdown source={f.description} />
                {f.code && (
                  <CodeBlock
                    code={f.code.text}
                    startLine={f.code.startLine}
                    highlight={Array.from({ length: f.endLine - f.startLine + 1 }, (_, k) => f.startLine + k)}
                    title={f.path}
                    id={`demo-code-${i}`}
                  />
                )}
                {f.impact && (
                  <p>
                    <strong>Why it matters:</strong> {f.impact}
                  </p>
                )}
                {f.suggestedFix && (
                  <p>
                    <strong>Suggested fix:</strong> {f.suggestedFix}
                  </p>
                )}
              </article>
            ))}
          </section>
        </>
      )}

      <section className="card" aria-labelledby="demo-cta">
        <div className="card-body stack-sm">
          <h2 id="demo-cta">Get reviews like this on every pull request</h2>
          <p className="dim">
            Install OpenReview on your repositories for reviews posted right on your pull requests, in standard and deep modes, with your team&apos;s rules
            and what it learns from your feedback. It is open source and runs on your own server.
          </p>
          <div className="row-tight">
            <Link className="button button-primary" href="/sign-in">
              Install OpenReview
            </Link>
            <Link className="button" href="/try">
              Try another pull request
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
