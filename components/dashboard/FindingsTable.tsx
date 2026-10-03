import Link from "next/link";
import { ConfidencePill, humanize, StatusPill } from "@/components/ui/Badge";
import { SortHeader, Table } from "@/components/ui/Table";
import type { FindingListItem } from "@/lib/data/findings";
import { formatRelative, githubBlobUrl, githubCommentUrl } from "@/lib/ui/format";
import type { QueryState } from "@/lib/ui/url";

/**
 * Findings across the org (R6.13): severity, confidence, title and location, repository and PR, status, agent, and
 * when it was found; sortable by date, severity, and confidence; each row links to its review and GitHub comment.
 */
export function FindingsTable({
  findings,
  pathname,
  state,
  githubUrl,
  now = new Date(),
}: {
  findings: FindingListItem[];
  pathname: string;
  state: QueryState;
  githubUrl?: string;
  now?: Date;
}) {
  const sort = { pathname, state, defaultField: "date" } as const;
  return (
    <Table caption="Findings">
      <thead>
        <tr>
          <SortHeader label="Severity" field="severity" {...sort} />
          <th scope="col">Finding</th>
          <th scope="col">Pull request</th>
          <th scope="col">Status</th>
          <SortHeader label="Confidence" field="confidence" {...sort} />
          <th scope="col">Agent</th>
          <SortHeader label="Found" field="date" {...sort} />
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => (
          <tr key={f.id} data-finding={f.id}>
            <td>
              <StatusPill kind="severity" value={f.severity} />
            </td>
            <td style={{ minWidth: 260, maxWidth: 440 }}>
              <Link className="cell-title" href={`/dashboard/reviews/${f.reviewId}#finding-${f.id}-title`}>
                {f.title}
              </Link>
              <div className="cell-sub row-tight">
                <a className="mono break" href={githubBlobUrl(f.repoFullName, f.commitSha, f.path, f.startLine, githubUrl)} target="_blank" rel="noreferrer">
                  {f.path}:{f.startLine}
                </a>
                <span>· {humanize(f.category)}</span>
                {f.externalCommentId !== null && (
                  <a href={githubCommentUrl(f.repoFullName, f.prNumber, f.externalCommentId, githubUrl)} target="_blank" rel="noreferrer">
                    · comment
                  </a>
                )}
              </div>
            </td>
            <td>
              <Link href={`/dashboard/reviews/${f.reviewId}`} className="nowrap">
                {f.repoFullName}#{f.prNumber}
              </Link>
              {f.prAuthor && <div className="cell-sub">@{f.prAuthor}</div>}
            </td>
            <td>
              <StatusPill kind="finding" value={f.status} />
            </td>
            <td>
              <ConfidencePill value={f.confidence} />
            </td>
            <td className="nowrap">{humanize(f.agent)}</td>
            <td className="nowrap">{formatRelative(f.createdAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
