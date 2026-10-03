import type { ReactNode } from "react";
import { Icon } from "./icons";

export type TimelineState = "done" | "current" | "interrupted" | "skipped" | "pending" | "ok" | "failed" | "stopped";

export interface TimelineItem {
  key: string;
  label: ReactNode;
  state: TimelineState;
  meta?: ReactNode;
  detail?: ReactNode;
}

const STATE_TEXT: Record<TimelineState, string> = {
  done: "done",
  current: "in progress",
  interrupted: "stopped here",
  skipped: "skipped",
  pending: "not reached",
  ok: "succeeded",
  failed: "failed",
  stopped: "stopped",
};

/** A vertical stepper (e.g. a review run's lifecycle): each step has a state, an optional meta column and detail. */
export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  return (
    <ol className="timeline" aria-label={label}>
      {items.map((it) => (
        <li key={it.key} className="timeline-step" data-state={it.state} data-step={it.key} aria-current={it.state === "current" ? "step" : undefined}>
          <span className="timeline-dot" aria-hidden="true">
            {(it.state === "done" || it.state === "ok") && <Icon name="check" size={12} strokeWidth={3} />}
            {(it.state === "failed" || it.state === "interrupted") && <Icon name="x" size={12} strokeWidth={3} />}
            {it.state === "stopped" && <Icon name="stop" size={10} strokeWidth={3} />}
          </span>
          <span className="timeline-label">
            {it.label}
            <span className="sr-only"> ({STATE_TEXT[it.state]})</span>
          </span>
          <span className="timeline-meta">{it.meta}</span>
          {it.detail && <div className="timeline-detail">{it.detail}</div>}
        </li>
      ))}
    </ol>
  );
}
