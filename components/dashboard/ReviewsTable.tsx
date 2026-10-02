import Link from "next/link";
import type { ReviewListItem } from "@/lib/data/reviews";
import { formatDate, githubPrUrl } from "./format";
import { StatusBadge } from "./StatusBadge";

/** Reviews: PR, status, comment count and credits used (R1.8). */
export function ReviewsTable({ reviews }: { reviews: ReviewListItem[] }) {
  if (reviews.length === 0) {
    return <p className="empty">No reviews yet. Open a pull request on a connected repository to get one.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Pull request</th>
          <th scope="col">Status</th>
          <th scope="col">Risk</th>
          <th scope="col">Comments</th>
          <th scope="col">Credits</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {reviews.map((r) => (
          <tr key={r.id} data-review={r.id}>
            <td>
              <Link href={`/dashboard/reviews/${r.id}`} className="strong">
                {r.repoFullName}#{r.prNumber}
              </Link>
              <div className="dim">
                {r.prTitle || "Untitled"}
                {r.prAuthor && <> · @{r.prAuthor}</>} ·{" "}
                <a href={githubPrUrl(r.repoFullName, r.prNumber)} rel="noreferrer" target="_blank">
                  GitHub
                </a>
              </div>
            </td>
            <td>
              <StatusBadge value={r.status} />
            </td>
            <td>{r.riskLevel ? <StatusBadge value={r.riskLevel} /> : "—"}</td>
            <td className="num">{r.commentCount}</td>
            <td className="num">{r.creditsUsed}</td>
            <td>{formatDate(r.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
