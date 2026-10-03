import { Fragment } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { parseUnifiedDiff } from "@/components/ui/Code";
import { EmptyState } from "@/components/ui/EmptyState";
import { Markdown } from "@/components/ui/Markdown";
import type { LocalCommentRow } from "@/lib/git/local/store";
import type { LocalPullRequestView, LocalThread } from "@/lib/git/local/view";
import { formatDate, shortSha } from "@/lib/ui/format";

/** Comment bodies without OpenReview's hidden markers (`<!-- openreview:… -->`). */
const visible = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

function Comment({ c }: { c: LocalCommentRow }) {
  return (
    <div className="comment" id={`comment-${c.id}`} data-comment={c.id}>
      <div className="row-tight dim">
        <span className="strong">@{c.author}</span>
        <span>· {formatDate(c.createdAt)}</span>
      </div>
      <Markdown source={visible(c.body)} headingOffset={3} />
    </div>
  );
}

function Thread({ t }: { t: LocalThread }) {
  return (
    <div className="stack-sm" data-thread={t.root.id}>
      <Comment c={t.root} />
      {t.replies.map((r) => (
        <div key={r.id} style={{ marginLeft: 24 }}>
          <Comment c={r} />
        </div>
      ))}
    </div>
  );
}

/** One file's diff with its inline comment threads under the lines they are attached to. */
function FileDiff({ file }: { file: LocalPullRequestView["files"][number] }) {
  const lines = file.patch ? parseUnifiedDiff(file.patch) : [];
  const byLine = new Map<number, LocalThread[]>();
  for (const t of file.threads) {
    const n = t.root.line ?? 0;
    byLine.set(n, [...(byLine.get(n) ?? []), t]);
  }
  const shown = new Set(lines.flatMap((l) => (l.newLine === null ? [] : [l.newLine])));
  const unplaced = file.threads.filter((t) => !shown.has(t.root.line ?? 0));
  return (
    <figure className="code" style={{ margin: 0 }} data-file={file.path}>
      <figcaption className="code-head">
        <span className="truncate">
          {file.previousPath ? `${file.previousPath} → ` : ""}
          {file.path}
        </span>
        <Badge tone="muted">{file.status}</Badge>
      </figcaption>
      {lines.length === 0 ? (
        <p className="dim" style={{ padding: "8px 12px", margin: 0 }}>
          No textual diff (binary or empty file).
        </p>
      ) : (
        <div className="code-scroll">
          <table>
            <tbody>
              {lines.map((l, i) => (
                <Fragment key={i}>
                  {l.kind === "hunk" ? (
                    <tr className="hunk">
                      <td className="ln" />
                      <td className="ln" />
                      <td className="mark" />
                      <td className="src">{l.text}</td>
                    </tr>
                  ) : (
                    <tr className={l.kind === "ctx" ? undefined : l.kind} id={l.newLine !== null ? `${encodeURIComponent(file.path)}-L${l.newLine}` : undefined}>
                      <td className="ln">{l.oldLine ?? ""}</td>
                      <td className="ln">{l.newLine ?? ""}</td>
                      <td className="mark" aria-hidden="true">
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                      </td>
                      <td className="src">
                        {l.kind !== "ctx" && <span className="sr-only">{l.kind === "add" ? "Added: " : "Removed: "}</span>}
                        {l.text || " "}
                      </td>
                    </tr>
                  )}
                  {l.newLine !== null &&
                    (byLine.get(l.newLine) ?? []).map((t) => (
                      <tr key={`t${t.root.id}`}>
                        <td colSpan={4} style={{ whiteSpace: "normal", padding: 12, fontFamily: "var(--font-sans)" }}>
                          <Thread t={t} />
                        </td>
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unplaced.length > 0 && (
        <div className="stack-sm" style={{ padding: 12 }}>
          {unplaced.map((t) => (
            <Thread key={t.root.id} t={t} />
          ))}
        </div>
      )}
    </figure>
  );
}

/** A local pull request (R6.22): commits, the diff with inline comments, and the conversation. */
export function LocalPullRequest({ view }: { view: LocalPullRequestView }) {
  const { pr } = view;
  return (
    <div className="stack">
      <Card title="Commits">
        <ul className="comments">
          {view.commits.map((c) => (
            <li key={c.sha} className="row-tight">
              <span className="mono">{shortSha(c.sha)}</span>
              <span>{c.message.split("\n")[0]}</span>
              <span className="dim">· {c.author}</span>
            </li>
          ))}
        </ul>
      </Card>
      <section className="stack-sm" aria-labelledby="local-files">
        <h2 id="local-files">
          Files changed <span className="dim">({view.files.length})</span>
        </h2>
        {view.files.length === 0 ? <EmptyState title="No changes" headingLevel={3}>{`${pr.headRef} has no changes against ${pr.baseRef}.`}</EmptyState> : view.files.map((f) => <FileDiff key={f.path} file={f} />)}
        {view.outdated.map((t) => (
          <Thread key={t.root.id} t={t} />
        ))}
      </section>
      <section className="stack-sm" aria-labelledby="local-conversation">
        <h2 id="local-conversation">Conversation</h2>
        {view.conversation.length === 0 ? (
          <p className="dim">No comments yet.</p>
        ) : (
          view.conversation.map((c) => <Comment key={c.id} c={c} />)
        )}
      </section>
    </div>
  );
}
