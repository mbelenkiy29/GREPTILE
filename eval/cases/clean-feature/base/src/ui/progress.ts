/** Width (0-100) of a progress bar for `done` of `total` steps. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}
