import type { ReactNode } from "react";

/** A KPI tile: a label, a big number, an optional hint, and an optional small chart. */
export function Stat({ label, value, hint, chart }: { label: string; value: ReactNode; hint?: ReactNode; chart?: ReactNode }) {
  return (
    <div className="stat" data-stat={label}>
      <span className="eyebrow">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
      {chart && <div className="stat-chart">{chart}</div>}
    </div>
  );
}
