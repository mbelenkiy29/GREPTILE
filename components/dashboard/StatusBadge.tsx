const TONES: Record<string, string> = {
  ready: "ok",
  completed: "ok",
  low: "ok",
  pending: "muted",
  queued: "muted",
  skipped: "muted",
  indexing: "info",
  running: "info",
  medium: "warn",
  failed: "bad",
  high: "bad",
  critical: "bad",
};

export function StatusBadge({ value }: { value: string }) {
  return <span className={`badge badge-${TONES[value] ?? "muted"}`}>{value}</span>;
}
