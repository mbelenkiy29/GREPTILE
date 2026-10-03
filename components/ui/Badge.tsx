import type { ReactNode } from "react";

export type Tone = "ok" | "info" | "warn" | "bad" | "muted" | "crit" | "accent" | "outline";

/** A small label. `dot` adds a status dot; `live` makes the dot pulse (work in progress). */
export function Badge({
  tone = "muted",
  dot = false,
  live = false,
  mono = false,
  title,
  status,
  children,
}: {
  status?: string;
  tone?: Tone;
  dot?: boolean;
  live?: boolean;
  mono?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const cls = ["badge", `badge-${tone}`, (dot || live) && "badge-dot", live && "badge-live", mono && "badge-mono"].filter(Boolean).join(" ");
  return (
    <span className={cls} title={title} data-status={status}>
      {children}
    </span>
  );
}

export type PillKind = "review" | "run" | "index" | "job" | "severity" | "finding" | "delivery" | "risk" | "agent" | "validation";

const TONES: Record<PillKind, Record<string, Tone>> = {
  review: { queued: "muted", running: "info", completed: "ok", failed: "bad", skipped: "muted", cancelled: "muted" },
  run: {
    queued: "muted",
    ingesting: "info",
    retrieving_context: "info",
    reviewing: "info",
    verifying: "info",
    summarizing: "info",
    publishing: "info",
    completed: "ok",
    failed: "bad",
    cancelled: "muted",
    superseded: "muted",
    skipped: "muted",
  },
  index: { pending: "muted", indexing: "info", ready: "ok", failed: "bad" },
  job: { queued: "muted", running: "info", completed: "ok", failed: "bad", cancelled: "muted" },
  severity: { critical: "crit", high: "bad", medium: "warn", low: "muted" },
  finding: { open: "info", resolved: "ok", dismissed: "muted", wont_fix: "muted", false_positive: "warn" },
  delivery: { processing: "info", accepted: "ok", ignored: "muted", failed: "bad" },
  risk: { low: "ok", medium: "warn", high: "bad" },
  agent: { ok: "ok", error: "bad", skipped: "muted" },
  validation: { queued: "muted", running: "info", passed: "ok", failed: "bad", timeout: "warn", error: "bad", skipped: "muted" },
};

const LIVE = new Set(["running", "indexing", "processing", "ingesting", "retrieving_context", "reviewing", "verifying", "summarizing", "publishing"]);

const LABELS: Record<string, string> = {
  retrieving_context: "Retrieving context",
  wont_fix: "Won't fix",
  false_positive: "False positive",
  api_compat: "API compatibility",
};

/** "retrieving_context" → "Retrieving context". */
export function humanize(value: string): string {
  if (Object.hasOwn(LABELS, value)) return LABELS[value]!;
  const s = value.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A status or severity as a colored pill (review status, run stage, index state, severity, finding status, …). */
export function StatusPill({ kind, value, label }: { kind: PillKind; value: string; label?: string }) {
  const tone = TONES[kind][value] ?? "muted";
  const live = LIVE.has(value);
  return (
    <Badge tone={tone} dot={kind !== "severity" && kind !== "risk"} live={live} status={value}>
      {label ?? humanize(value)}
    </Badge>
  );
}

/** Confidence 0..1 as a pill: high (≥ 0.8), medium (≥ 0.5), low. */
export function ConfidencePill({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone: Tone = value >= 0.8 ? "ok" : value >= 0.5 ? "info" : "warn";
  const word = value >= 0.8 ? "High" : value >= 0.5 ? "Medium" : "Low";
  return (
    <Badge tone={tone} title={`Confidence ${pct}%`}>
      {word} · {pct}%
    </Badge>
  );
}
