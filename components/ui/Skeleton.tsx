import type { CSSProperties } from "react";

/** A shimmering placeholder block. */
export function Skeleton({ width = "100%", height = 14, radius, style }: { width?: number | string; height?: number | string; radius?: number; style?: CSSProperties }) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />;
}

/** A page-shaped loading state: heading, KPI row or filter bar, and table rows. Announced as busy. */
export function PageSkeleton({ kpis = 0, rows = 6, label = "Loading" }: { kpis?: number; rows?: number; label?: string }) {
  return (
    <div className="stack" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <div className="stack-sm">
        <Skeleton width={120} height={12} />
        <Skeleton width={260} height={28} />
      </div>
      {kpis > 0 && (
        <div className="grid-kpi">
          {Array.from({ length: kpis }, (_, i) => (
            <div key={i} className="stat">
              <Skeleton width={90} height={10} />
              <Skeleton width={70} height={30} />
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <div className="card-body">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
              <Skeleton width="38%" height={14} />
              <Skeleton width="18%" height={14} />
              <Skeleton width="14%" height={14} />
              <Skeleton width="20%" height={14} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
