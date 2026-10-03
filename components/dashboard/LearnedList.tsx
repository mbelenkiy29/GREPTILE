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
  /** `category` preferences cover every finding of a category (R6.10). */
  kind?: "pattern" | "category";
  source?: "feedback" | "reply" | "command" | "human_rule";
  confidenceDelta?: number;
}

const SOURCE_LABEL = { feedback: "from feedback", reply: "from replies", command: "from a command", human_rule: "written by a person" } as const;

const SIGNAL_LABEL = { suppress: "Suppressed", boost: "Prioritized", neutral: "Observing" } as const;
const SIGNAL_TONE = { suppress: "bad", boost: "ok", neutral: "muted" } as const;

/** Conventions inferred from feedback on OpenReview comments (R2.4). */
export function LearnedList({ items, actions }: { items: LearnedItem[]; actions?: (i: LearnedItem) => ReactNode }) {
  if (!items.length) {
    return <p className="empty">Nothing learned yet. React with 👍 or 👎, or reply, on OpenReview comments to teach it your team&apos;s preferences.</p>;
  }
  return (
    <ul className="comments">
      {items.map((i) => (
        <li key={i.id} className="comment" data-pattern={i.id}>
          <div className="row">
            <span className={`badge badge-${SIGNAL_TONE[i.signal]}`}>{SIGNAL_LABEL[i.signal]}</span>
            <span className="dim">{i.kind === "category" ? `Whole category: ${i.category}` : i.category}</span>
            <span className="dim">{i.repoFullName ?? "All repositories"}</span>
            <span className="dim">
              +{i.positive} / −{i.negative}
              {i.userEdited ? " · set by you" : ""}
              {i.source && i.source !== "feedback" ? ` · ${SOURCE_LABEL[i.source]}` : ""}
            </span>
            {i.kind === "category" && i.signal === "suppress" && (i.confidenceDelta ?? 0) > 0 && (
              <span className="dim">minimum confidence +{(i.confidenceDelta ?? 0).toFixed(2)}</span>
            )}
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
