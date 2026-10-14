import { chartScale, linePoints, segments, type Series } from "../../src/charts";

// Accessible SVG line chart and bar list using theme tokens; each chart also renders its data as
// a visually hidden table for screen readers.
const palette = ["var(--accent)", "var(--success)", "var(--warning)", "var(--error)"];
export function LineChart({ title, labels, series, format = (v: number) => String(v), height = 160 }: { title: string; labels: string[]; series: Series[]; format?: (v: number) => string; height?: number }) {
  const width = 640, max = chartScale(series);
  return <figure className="chart">
    <figcaption>{title}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${series.map((s) => s.label).join(", ")}`} preserveAspectRatio="none">
      {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={width} y1={4 + (height - 8) * f} y2={4 + (height - 8) * f} className="chart-grid" />)}
      {series.map((s, i) => segments(linePoints(s.values, max, width, height)).map((pts, j) => <polyline key={`${i}-${j}`} points={pts} fill="none" stroke={palette[i % palette.length]} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />))}
    </svg>
    <div className="chart-legend">{series.map((s, i) => <span key={s.label}><i style={{ background: palette[i % palette.length] }} />{s.label}</span>)}<span className="muted">max {format(max)} · {labels[0]} – {labels.at(-1)}</span></div>
    <div className="sr-only"><table><caption>{title}</caption><thead><tr><th>Day</th>{series.map((s) => <th key={s.label}>{s.label}</th>)}</tr></thead><tbody>{labels.map((l, i) => <tr key={l}><td>{l}</td>{series.map((s) => <td key={s.label}>{s.values[i] === null ? "—" : format(s.values[i]!)}</td>)}</tr>)}</tbody></table></div>
  </figure>;
}
export function BarList({ title, items, format = (v: number) => String(v) }: { title: string; items: { label: string; value: number; detail?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return <figure className="chart"><figcaption>{title}</figcaption>
    {items.length === 0 ? <p className="muted">No activity in this period.</p> : <ul className="bar-list">{items.map((i) => <li key={i.label}><span className="bar-label">{i.label}</span><span className="bar-track"><span className="bar-fill" style={{ width: `${(i.value / max) * 100}%` }} /></span><span className="bar-value">{format(i.value)}{i.detail ? <span className="muted"> · {i.detail}</span> : null}</span></li>)}</ul>}
  </figure>;
}
