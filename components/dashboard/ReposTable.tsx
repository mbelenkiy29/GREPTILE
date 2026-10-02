import type { ReactNode } from "react";
import { formatDate } from "./format";
import { StatusBadge } from "./StatusBadge";

export interface RepoRow {
  id: number;
  fullName: string;
  defaultBranch: string;
  enabled: boolean;
  indexStatus: string;
  indexError: string | null;
  indexedSha: string | null;
  indexedAt: Date | null;
  fileCount: number;
  symbolCount: number;
}

/** Connected repositories and their index status (R1.8). `actions` renders per-row controls. */
export function ReposTable({ repos, actions }: { repos: RepoRow[]; actions?: (repo: RepoRow) => ReactNode }) {
  if (repos.length === 0) {
    return <p className="empty">No repositories connected yet. Connect GitHub to choose repositories to review.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Repository</th>
          <th scope="col">Index</th>
          <th scope="col">Files</th>
          <th scope="col">Symbols</th>
          <th scope="col">Last indexed</th>
          <th scope="col">Reviews</th>
          {actions && <th scope="col"><span className="sr-only">Actions</span></th>}
        </tr>
      </thead>
      <tbody>
        {repos.map((r) => (
          <tr key={r.id} data-repo={r.fullName}>
            <td>
              <div className="strong">{r.fullName}</div>
              <div className="dim">{r.defaultBranch}</div>
            </td>
            <td>
              <StatusBadge value={r.indexStatus} />
              {r.indexStatus === "failed" && r.indexError && <div className="error-text">{r.indexError}</div>}
            </td>
            <td className="num">{r.fileCount}</td>
            <td className="num">{r.symbolCount}</td>
            <td>
              {formatDate(r.indexedAt)}
              {r.indexedSha && <div className="dim mono">{r.indexedSha.slice(0, 7)}</div>}
            </td>
            <td>{r.enabled ? "On" : "Off"}</td>
            {actions && <td className="actions">{actions(r)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
