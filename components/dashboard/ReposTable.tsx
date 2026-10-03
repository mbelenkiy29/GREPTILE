import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, humanize, StatusPill } from "@/components/ui/Badge";
import { CellTitle, Table } from "@/components/ui/Table";
import type { RepoListItem } from "@/lib/data/repos";
import { Icon } from "@/components/ui/icons";
import { commitUrl, PROVIDER_LABEL, providerIcon, repoUrl, repoWeb } from "@/lib/git/web-url";
import { formatRelative, shortSha } from "@/lib/ui/format";
import { IndexStatus } from "./IndexStatus";

export type RepoRow = RepoListItem;

/** The repository's git host as a small labelled icon (R3.6). */
export function ProviderIcon({ provider }: { provider: string }) {
  return <Icon name={providerIcon(provider)} size={12} title={PROVIDER_LABEL[provider] ?? provider} />;
}

function ReviewsState({ repo }: { repo: Pick<RepoRow, "enabled" | "archived"> }) {
  if (repo.archived) return <Badge tone="muted">Archived</Badge>;
  return repo.enabled ? (
    <Badge tone="ok" dot>
      On
    </Badge>
  ) : (
    <Badge tone="warn" dot>
      Paused
    </Badge>
  );
}

/** Connected repositories with index, review, and findings state (R1.8, R6.13). `actions` renders per-row controls. */
export function ReposTable({
  repos,
  actions,
  githubUrl,
  now = new Date(),
}: {
  repos: RepoRow[];
  actions?: (repo: RepoRow) => ReactNode;
  githubUrl?: string;
  now?: Date;
}) {
  return (
    <Table caption="Repositories">
      <thead>
        <tr>
          <th scope="col">Repository</th>
          <th scope="col">Reviews</th>
          <th scope="col">Index</th>
          <th scope="col">Last indexed</th>
          <th scope="col">Mode</th>
          <th scope="col" className="num">
            Open findings
          </th>
          <th scope="col">Last review</th>
          {actions && (
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {repos.map((r) => (
          <tr key={r.id} data-repo={r.fullName}>
            <td>
              <CellTitle
                href={`/dashboard/repos/${r.id}`}
                sub={
                  <>
                    <ProviderIcon provider={r.provider} /> {r.accountLogin} · <span className="mono">{r.defaultBranch}</span> · {r.private ? "private" : "public"} ·{" "}
                    <a href={repoUrl(repoWeb(r.provider, r.hostWebUrl, githubUrl), r.fullName)} target="_blank" rel="noreferrer">
                      {PROVIDER_LABEL[r.provider] ?? r.provider}
                    </a>
                  </>
                }
              >
                {r.fullName}
              </CellTitle>
            </td>
            <td>
              <ReviewsState repo={r} />
            </td>
            <td>
              <IndexStatus status={r.indexStatus} error={r.indexError} job={r.indexJob} repoName={r.fullName} />
            </td>
            <td className="nowrap">
              {r.indexedSha ? (
                <>
                  <a className="mono" href={commitUrl(repoWeb(r.provider, r.hostWebUrl, githubUrl), r.fullName, r.indexedSha)} target="_blank" rel="noreferrer">
                    {shortSha(r.indexedSha)}
                  </a>
                  <div className="dim">{formatRelative(r.indexedAt, now)}</div>
                </>
              ) : (
                <span className="dim">Never</span>
              )}
            </td>
            <td>
              <span title={`From ${r.reviewModeSource} settings`}>{humanize(r.reviewMode)}</span>
            </td>
            <td className="num">{r.openFindings}</td>
            <td className="nowrap">
              {r.lastReview ? (
                <>
                  <Link href={`/dashboard/reviews/${r.lastReview.id}`}>#{r.lastReview.prNumber}</Link>{" "}
                  <StatusPill kind="review" value={r.lastReview.status} />
                  <div className="dim">{formatRelative(r.lastReview.updatedAt, now)}</div>
                </>
              ) : (
                <span className="dim">None yet</span>
              )}
            </td>
            {actions && (
              <td>
                <div className="actions">{actions(r)}</div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
