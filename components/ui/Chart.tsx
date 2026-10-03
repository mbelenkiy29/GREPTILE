/** Tiny dependency-free SVG charts for activity over time (R6.13). */

export interface Point {
  label: string;
  value: number;
}

function summary(points: Point[], unit: string) {
  const total = points.reduce((n, p) => n + p.value, 0);
  const peak = points.reduce((m, p) => (p.value > m.value ? p : m), points[0] ?? { label: "", value: 0 });
  return `${total.toLocaleString("en-US")} ${unit} over ${points.length} days${total ? `; peak ${peak.value} on ${peak.label}` : ""}.`;
}

/**
 * A bar chart: one bar per point, zero values drawn as a hairline. Each bar has a `<title>` for hover; the whole
 * chart is an image with a text summary for screen readers.
 */
export function BarChart({ points, height = 64, unit = "reviews", label }: { points: Point[]; height?: number; unit?: string; label: string }) {
  const n = Math.max(points.length, 1);
  const width = n * 10;
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${summary(points, unit)}`} style={{ height }}>
      <line className="axis" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => {
        const h = p.value === 0 ? 1.5 : Math.max(2, (p.value / max) * (height - 4));
        return (
          <rect key={p.label} className={p.value === 0 ? "bar bar-muted" : "bar"} x={i * 10 + 1.5} y={height - h} width={7} height={h} rx={1.5}>
            <title>{`${p.label}: ${p.value} ${unit}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** A sparkline (line + soft area). */
export function Sparkline({ points, height = 32, unit = "reviews", label }: { points: Point[]; height?: number; unit?: string; label: string }) {
  const width = 120;
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((p, i) => [i * step, height - 2 - (p.value / max) * (height - 4)] as const);
  const line = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = coords.length ? `${line} L${width},${height} L0,${height} Z` : "";
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${summary(points, unit)}`} style={{ height }}>
      {area && <path className="area" d={area} />}
      {line && <path className="line" d={line} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** A determinate progress bar (0..1), or an indeterminate one when `value` is null. */
export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const pct = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      data-indeterminate={pct === null ? "true" : undefined}
    >
      <span style={{ width: `${pct ?? 35}%` }} />
    </div>
  );
}
