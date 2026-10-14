// Geometry for the dashboard's SVG charts (no chart dependency): series → polyline points within
// a padded box, with a shared y scale starting at zero.
export type Series = { label: string; values: (number | null)[] };
export function chartScale(series: Series[], minMax = 1) {
  return Math.max(minMax, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v))));
}
export function linePoints(values: (number | null)[], max: number, width: number, height: number, pad = 4) {
  const n = values.length, w = width - pad * 2, h = height - pad * 2;
  return values.map((v, i) => v === null || !Number.isFinite(v) ? null : `${(pad + (n <= 1 ? w / 2 : (i * w) / (n - 1))).toFixed(1)},${(pad + h - (Math.max(0, v) / (max || 1)) * h).toFixed(1)}`);
}
// Splits points into continuous runs so gaps (null) are not bridged.
export function segments(points: (string | null)[]) {
  const out: string[] = []; let run: string[] = [];
  for (const p of points) { if (p === null) { if (run.length) out.push(run.join(" ")); run = []; } else run.push(p); }
  if (run.length) out.push(run.join(" "));
  return out;
}
