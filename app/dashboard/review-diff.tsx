import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { parsePatch, placeFindings } from "../../src/diff-view";
import { priorityBadge } from "../../src/priority";

type Finding = { _id: string; title: string; severity: string; filePath: string; startLine: number; endLine: number; description: string };
// The reviewed change with findings shown inline at their lines (loaded only on request).
export async function ReviewDiff({ token, reviewId, findings, open, finished }: { token: string; reviewId: Id<"reviews">; findings: Finding[]; open: boolean; finished: boolean }) {
  // Running reviews auto-refresh the page; the diff loads only once the review has finished.
  if (!finished) return <section aria-labelledby="diff-heading"><h2 id="diff-heading">Changes</h2><p className="muted">The reviewed diff is available when the review finishes.</p></section>;
  if (!open) return <section aria-labelledby="diff-heading"><h2 id="diff-heading">Changes</h2><p><Link className="button" href={`?diff=1#diff-heading`}>Show the reviewed diff with findings inline</Link></p><p className="muted">Fetches the reviewed revision from the provider on request.</p></section>;
  let diff;
  try { diff = await backend().action(api.reviewDiff.load, { token, reviewId }); }
  catch { return <section aria-labelledby="diff-heading"><h2 id="diff-heading">Changes</h2><p role="alert">The diff could not be loaded from the provider. Check the repository connection and try again.</p></section>; }
  return <section aria-labelledby="diff-heading" className="review-diff">
    <h2 id="diff-heading">Changes</h2>
    {diff.source === "unavailable" ? <p role="status">{diff.reason}</p> : <p className="muted">{diff.source === "compare" ? "Exact base…head comparison" : "Pull request diff"} at {diff.revision.slice(0, 12)} · {diff.files.length} files{diff.omitted ? ` (${diff.omitted} more not shown)` : ""}</p>}
    {diff.files.map((file) => {
      const hunks = parsePatch(file.patch), here = findings.filter((f) => f.filePath === file.path), placed = placeFindings(hunks, here);
      return <details key={file.path} open={here.length > 0} className="diff-file">
        <summary><code>{file.path}</code> <span className="muted">{file.status}{here.length ? ` · ${here.length} finding${here.length === 1 ? "" : "s"}` : ""}</span></summary>
        {placed.outside.map((f) => <p key={f._id} className="diff-note"><span className={`badge ${f.severity}`}>{priorityBadge(f.severity)}</span> {f.title} <span className="muted">· line {f.startLine}, outside the changed hunks</span></p>)}
        {hunks.length === 0 ? <p className="muted">No text diff (binary, renamed or too large).</p> : <div className="table-scroll"><table className="diff-table"><tbody>
          {hunks.map((h, hi) => [<tr key={`h${hi}`} className="diff-hunk"><td colSpan={3}><code>{h.header}</code></td></tr>, ...h.lines.flatMap((l, li) => {
            const row = <tr key={`${hi}-${li}`} className={`diff-${l.kind}`}><td className="diff-num">{l.old ?? ""}</td><td className="diff-num">{l.new ?? ""}</td><td><code>{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}{l.text}</code></td></tr>;
            const notes = l.new !== undefined ? placed.at.get(l.new) ?? [] : [];
            return [row, ...notes.map((f) => <tr key={`${hi}-${li}-${f._id}`} className="diff-finding"><td colSpan={2}></td><td><span className={`badge ${f.severity}`}>{priorityBadge(f.severity)}</span> <strong>{f.title}</strong><p>{f.description.slice(0, 400)}</p></td></tr>)];
          })])}
        </tbody></table></div>}
        {file.truncated && <p className="muted">Patch truncated for display.</p>}
      </details>;
    })}
  </section>;
}
