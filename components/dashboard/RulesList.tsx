import type { ReactNode } from "react";

export interface RuleItem {
  id: number;
  text: string;
  paths: string[];
  status: string;
  source: string;
  repoFullName: string | null;
  rationale: string | null;
  evidence: { commentId: number; author: string; excerpt: string }[] | null;
}

/** Custom rules with their scope (R2.1); `actions` renders per-rule controls. */
export function RulesList({ rules, empty, actions }: { rules: RuleItem[]; empty: string; actions?: (r: RuleItem) => ReactNode }) {
  if (!rules.length) return <p className="empty">{empty}</p>;
  return (
    <ul className="comments">
      {rules.map((r) => (
        <li key={r.id} className="comment" data-rule={r.id}>
          <div className="row">
            <span className="badge badge-muted">{r.repoFullName ?? "All repositories"}</span>
            {r.paths.length > 0 ? (
              <span className="mono dim">{r.paths.join(", ")}</span>
            ) : (
              <span className="dim">all files</span>
            )}
            <span className="dim">· rule:{r.id} · {r.source}</span>
          </div>
          <div className="strong">{r.text}</div>
          {r.rationale && <p className="dim">{r.rationale}</p>}
          {r.evidence && r.evidence.length > 0 && (
            <ul className="dim">
              {r.evidence.map((e) => (
                <li key={e.commentId}>
                  @{e.author}: “{e.excerpt}”
                </li>
              ))}
            </ul>
          )}
          {actions && <div className="row actions">{actions(r)}</div>}
        </li>
      ))}
    </ul>
  );
}
