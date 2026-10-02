import type { ReactNode } from "react";

export interface LearnedItem {
  id: number;
  category: string;
  description: string;
  signal: "suppress" | "boost" | "neutral";
  positive: number;
  negative: number;
  examples: { title: string; path: string }[];
  userEdited: boolean;
  repoFullName: string | null;
}

const SIGNAL_LABEL = { suppress: "Suppressed", boost: "Prioritized", neutral: "Observing" } as const;
const SIGNAL_TONE = { suppress: "bad", boost: "ok", neutral: "muted" } as const;

/** Conventions inferred from feedback on Tracewise comments (R2.4). */
export function LearnedList({ items, actions }: { items: LearnedItem[]; actions?: (i: LearnedItem) => ReactNode }) {
  if (!items.length) {
    return <p className="empty">Nothing learned yet. React with 👍 or 👎, or reply, on Tracewise comments to teach it your team&apos;s preferences.</p>;
  }
  return (
    <ul className="comments">
      {items.map((i) => (
        <li key={i.id} className="comment" data-pattern={i.id}>
          <div className="row">
            <span className={`badge badge-${SIGNAL_TONE[i.signal]}`}>{SIGNAL_LABEL[i.signal]}</span>
            <span className="dim">{i.category}</span>
            <span className="dim">{i.repoFullName ?? "All repositories"}</span>
            <span className="dim">
              +{i.positive} / −{i.negative}
              {i.userEdited ? " · set by you" : ""}
            </span>
          </div>
          <div className="strong">{i.description}</div>
          {i.examples.length > 0 && (
            <ul className="dim">
              {i.examples.map((e, n) => (
                <li key={n}>
                  {e.title} <span className="mono">({e.path})</span>
                </li>
              ))}
            </ul>
          )}
          {actions && <div className="row actions">{actions(i)}</div>}
        </li>
      ))}
    </ul>
  );
}
