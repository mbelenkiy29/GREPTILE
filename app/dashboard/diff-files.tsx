import { parsePatch, placeFindings } from "../../src/diff-view";

export type DiffFinding = { _id: string; title: string; severity: string; filePath: string; startLine: number; endLine: number; description: string };
export type DiffFile = { path: string; status: string; patch: string; truncated: boolean };
// One collapsible block per changed file with findings shown inline after the line they anchor
// to. Pure rendering, shared by the review page and the landing page's replica of it.
export function DiffFiles({ files, findings }: { files: DiffFile[]; findings: DiffFinding[] }) {
  return <>{files.map((file) => {
    const hunks = parsePatch(file.patch), here = findings.filter((f) => f.filePath === file.path), placed = placeFindings(hunks, here);
    return <details key={file.path} open={here.length > 0} className="diff-file">
      <summary><code>{file.path}</code> <span className="muted">{file.status}{here.length ? ` · ${here.length} finding${here.length === 1 ? "" : "s"}` : ""}</span></summary>
      {placed.outside.map((f) => <p key={f._id} className="diff-note"><span className={`badge ${f.severity}`}>{f.severity}</span> {f.title} <span className="muted">· line {f.startLine}, outside the changed hunks</span></p>)}
      {hunks.length === 0 ? <p className="muted">No text diff (binary, renamed or too large).</p> : <div className="table-scroll"><table className="diff-table"><tbody>
        {hunks.map((h, hi) => [<tr key={`h${hi}`} className="diff-hunk"><td colSpan={3}><code>{h.header}</code></td></tr>, ...h.lines.flatMap((l, li) => {
          const row = <tr key={`${hi}-${li}`} className={`diff-${l.kind}`}><td className="diff-num">{l.old ?? ""}</td><td className="diff-num">{l.new ?? ""}</td><td><code>{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}{l.text}</code></td></tr>;
          const notes = l.new !== undefined ? placed.at.get(l.new) ?? [] : [];
          return [row, ...notes.map((f) => <tr key={`${hi}-${li}-${f._id}`} className="diff-finding"><td colSpan={2}></td><td><span className={`badge ${f.severity}`}>{f.severity}</span> <strong>{f.title}</strong><p>{f.description.slice(0, 400)}</p></td></tr>)];
        })])}
      </tbody></table></div>}
      {file.truncated && <p className="muted">Patch truncated for display.</p>}
    </details>;
  })}</>;
}
