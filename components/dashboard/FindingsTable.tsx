import Link from "next/link";
import type { ReactNode } from "react";
import { FixWithAiMenu } from "@/components/fix/FixWithAi";
import { ConfidencePill, humanize, StatusPill } from "@/components/ui/Badge";
import { SortHeader, Table } from "@/components/ui/Table";
import type { FindingListItem } from "@/lib/data/findings";
import { formatRelative } from "@/lib/ui/format";
import { blobUrl, commentUrl, repoWeb } from "@/lib/git/web-url";
import type { QueryState } from "@/lib/ui/url";

/**
 * Findings across the org (R6.13): severity, confidence, title and location, repository and PR, status, agent, and
 * when it was found; sortable by date, severity, and confidence; each row links to its review and its comment on the repository's git host.
 */
export function FindingsTable({
  findings,
  pathname,
  state,
  githubUrl,
  now = new Date(),
  feedback,
}: {
  findings: FindingListItem[];
  pathname: string;
  state: QueryState;
  githubUrl?: string;
  now?: Date;
  /** Feedback controls for a finding (R6.10); they replace the plain status pill when given. */
  feedback?: (f: FindingListItem) => ReactNode;
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
          <th scope="col">
            <span className="sr-only">Fix with AI</span>
          </th>
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
                <a className="mono break" href={blobUrl(repoWeb(f.provider, f.hostWebUrl, githubUrl), f.repoFullName, f.commitSha, f.path, f.startLine)} target="_blank" rel="noreferrer">
                  {f.path}:{f.startLine}
                </a>
                <span>· {humanize(f.category)}</span>
                {f.externalCommentId !== null && (
                  <a href={commentUrl(repoWeb(f.provider, f.hostWebUrl, githubUrl), f.repoFullName, f.prNumber, f.externalCommentId)} target="_blank" rel="noreferrer">
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
            <td style={feedback ? { minWidth: 220 } : undefined}>{feedback ? feedback(f) : <StatusPill kind="finding" value={f.status} />}</td>
            <td>
              <ConfidencePill value={f.confidence} />
            </td>
            <td className="nowrap">{humanize(f.agent)}</td>
            <td className="nowrap">{formatRelative(f.createdAt, now)}</td>
            <td>
              <FixWithAiMenu findingId={f.id} compact />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
