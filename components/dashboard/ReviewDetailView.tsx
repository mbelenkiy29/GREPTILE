import type { ReviewDetail } from "@/lib/data/reviews";
import { formatDate, githubPrUrl } from "./format";
import { StatusBadge } from "./StatusBadge";

/** One review: outcome, usage, and every inline comment posted (R1.8). */
export function ReviewDetailView({ review }: { review: ReviewDetail }) {
  const prUrl = githubPrUrl(review.repoFullName, review.prNumber);
  return (
    <article className="stack">
      <header className="stack-sm">
        <h1>
          {review.repoFullName}#{review.prNumber} {review.prTitle && <span className="dim">— {review.prTitle}</span>}
        </h1>
        <div className="row">
          <StatusBadge value={review.status} />
          {review.riskLevel && (
            <span>
              Risk <StatusBadge value={review.riskLevel} />
            </span>
          )}
          {review.confidence !== null && <span>Confidence {review.confidence}/5</span>}
          <a href={prUrl} rel="noreferrer" target="_blank">
            Open on GitHub
          </a>
        </div>
      </header>

      <dl className="facts">
        <div><dt>Author</dt><dd>{review.prAuthor ? `@${review.prAuthor}` : "—"}</dd></div>
        <div><dt>Head</dt><dd className="mono">{review.headSha.slice(0, 7)}</dd></div>
        <div><dt>Runs</dt><dd>{review.runs}</dd></div>
        <div><dt>Credits used</dt><dd>{review.creditsUsed}</dd></div>
        <div><dt>Tokens</dt><dd>{review.usage ? `${review.usage.inputTokens.toLocaleString("en-US")} in / ${review.usage.outputTokens.toLocaleString("en-US")} out` : "—"}</dd></div>
        <div><dt>Updated</dt><dd>{formatDate(review.updatedAt)}</dd></div>
      </dl>

      {review.error && <p className="error-text">Last run failed: {review.error}</p>}

      {review.summary && (
        <section className="stack-sm">
          <h2>What changed</h2>
          <ul>
            {review.summary.split("\n").map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack-sm">
        <h2>Inline comments ({review.comments.length})</h2>
        {review.comments.length === 0 ? (
          <p className="empty">No inline comments were posted.</p>
        ) : (
          <ul className="comments">
            {review.comments.map((c) => (
              <li key={c.id} className="comment" data-comment={c.id}>
                <div className="row">
                  <StatusBadge value={c.severity} />
                  <span className="dim">{c.category}</span>
                  <a className="mono" href={`https://github.com/${review.repoFullName}/blob/${c.headSha}/${c.path}#L${c.line}`} rel="noreferrer" target="_blank">
                    {c.path}:{c.line}
                  </a>
                </div>
                <div className="strong">{c.title}</div>
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
