// Unified diffs computed locally, for providers whose APIs return changed files but not patches
// (Azure DevOps). Myers' O((N+M)D) line diff with a bounded edit distance; beyond the bound the
// whole file is shown as replaced, which stays correct but less precise.
const lines = (text: string) => { if (!text) return []; const out = text.replace(/\r\n/g, "\n").split("\n"); if (out.at(-1) === "") out.pop(); return out; };
type Op = { op: " " | "-" | "+"; text: string };
export function lineDiff(a: string[], b: string[], maxEdits = 4000): Op[] {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const offset = max + 1, v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
  const limit = Math.min(max, maxEdits);
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
}
function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, d: number): Op[] {
  const out: Op[] = [];
  let x = a.length, y = b.length;
  for (let depth = d; depth > 0; depth--) {
    const v = trace[depth], k = x - y;
    const prevK = k === -depth || (k !== depth && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ op: " ", text: a[--x] }); y--; }
    if (x === prevX) out.push({ op: "+", text: b[--y] }); else out.push({ op: "-", text: a[--x] });
  }
  while (x > 0 && y > 0) { out.push({ op: " ", text: a[--x] }); y--; }
  return out.reverse();
}
// Standard unified-diff hunks ("@@ -a,b +c,d @@") with `context` unchanged lines around changes.
export function unifiedPatch(oldText: string, newText: string, context = 3): string {
  const ops = lineDiff(lines(oldText), lines(newText));
  const hunks: string[] = [];
  let i = 0;
  const oldAt: number[] = [], newAt: number[] = [];
  for (let o = 1, n = 1, j = 0; j < ops.length; j++) { oldAt.push(o); newAt.push(n); if (ops[j].op !== "+") o++; if (ops[j].op !== "-") n++; }
  while (i < ops.length) {
    while (i < ops.length && ops[i].op === " ") i++;
    if (i >= ops.length) break;
    let start = Math.max(0, i - context), end = i;
    for (;;) {
      while (end < ops.length && ops[end].op !== " ") end++;
      let next = end;
      while (next < ops.length && ops[next].op === " ") next++;
      if (next < ops.length && next - end <= context * 2) { end = next; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((o) => o.op !== "+").length, newCount = slice.filter((o) => o.op !== "-").length;
    const oldStart = oldCount ? oldAt[start] : Math.max(0, oldAt[start] - 1), newStart = newCount ? newAt[start] : Math.max(0, newAt[start] - 1);
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n` + slice.map((o) => o.op + o.text).join("\n"));
    i = end;
    start = end;
  }
  return hunks.join("\n");
}
