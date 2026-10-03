import { humanize, StatusPill } from "@/components/ui/Badge";
import { CellTitle, Table } from "@/components/ui/Table";
import { runDurationMs } from "@/lib/data/lifecycle";
import type { ReviewPageItem } from "@/lib/data/reviews";
import { formatDuration, formatRelative, formatUsd, githubCommitUrl, githubPrUrl, shortSha } from "@/lib/ui/format";

/** The model(s) a run used, compactly: the review model, or the distinct models joined. */
export function modelLabel(models: Record<string, string> | null | undefined): string {
  if (!models) return "—";
  const distinct = [...new Set(Object.values(models))];
  if (!distinct.length) return "—";
  return distinct.length === 1 ? distinct[0]! : `${models.review ?? models.correctness ?? distinct[0]} +${distinct.length - 1}`;
}

/** Reviews (R1.8, R6.13): PR, author, head, status, duration, model, findings and comments, cost and credits, timing. */
export function ReviewsTable({ reviews, githubUrl, now = new Date() }: { reviews: ReviewPageItem[]; githubUrl?: string; now?: Date }) {
  return (
    <Table caption="Reviews">
      <thead>
        <tr>
          <th scope="col">Pull request</th>
          <th scope="col">Status</th>
          <th scope="col" className="num">
            Findings
          </th>
          <th scope="col">Head</th>
          <th scope="col">Duration</th>
          <th scope="col">Model</th>
          <th scope="col" className="num">
            Cost
          </th>
          <th scope="col">Started</th>
          <th scope="col">Completed</th>
        </tr>
      </thead>
      <tbody>
        {reviews.map((r) => {
          const run = r.lastRun;
          return (
            <tr key={r.id} data-review={r.id}>
              <td style={{ minWidth: 240 }}>
                <CellTitle
                  href={`/dashboard/reviews/${r.id}`}
                  sub={
                    <>
                      {r.prTitle || "Untitled"}
                      {r.prAuthor && <> · @{r.prAuthor}</>} ·{" "}
                      <a href={githubPrUrl(r.repoFullName, r.prNumber, githubUrl)} target="_blank" rel="noreferrer">
                        GitHub
                      </a>
                    </>
                  }
                >
                  {r.repoFullName}#{r.prNumber}
                </CellTitle>
              </td>
              <td>
                <div className="stack-sm" style={{ gap: 4 }}>
                  <StatusPill kind="review" value={r.status} />
                  <span className="dim">{humanize(r.mode)}</span>
                </div>
              </td>
              <td className="num" data-col="findings">
                {r.findings}
                {r.highestSeverity && (
                  <div>
                    <StatusPill kind="severity" value={r.highestSeverity} />
                  </div>
                )}
                <div className="cell-sub nowrap" data-col="comments">
                  {r.commentCount} comment{r.commentCount === 1 ? "" : "s"}
                </div>
              </td>
              <td>
                <a className="mono" href={githubCommitUrl(r.repoFullName, r.headSha, githubUrl)} target="_blank" rel="noreferrer">
                  {shortSha(r.headSha)}
                </a>
              </td>
              <td className="nowrap num">{run ? formatDuration(runDurationMs(run, now)) : "—"}</td>
              <td className="mono dim truncate" style={{ maxWidth: 180 }}>
                {modelLabel(run?.models)}
              </td>
              <td className="num" data-col="cost">
                {formatUsd(r.costUsd)}
                <div className="cell-sub nowrap" data-col="credits">
                  {r.creditsUsed} credit{r.creditsUsed === 1 ? "" : "s"}
                </div>
              </td>
              <td className="nowrap">{formatRelative(run?.startedAt ?? r.createdAt, now)}</td>
              <td className="nowrap">{run?.finishedAt ? formatRelative(run.finishedAt, now) : <span className="dim">—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
