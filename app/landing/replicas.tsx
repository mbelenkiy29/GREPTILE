import type { ReactNode } from "react";
import { DiffFiles } from "../dashboard/diff-files";
import { ReviewMarkdown } from "../dashboard/markdown";
import { status } from "../dashboard/sections/shared";
import { LineChart } from "../ui/charts";
import { Mark } from "../ui/logo";
import { analytics, chat, diffFiles, diffFindings, findings, fixPrompt, history, pull, score, summary } from "./sample";

// Static replicas of real dashboard screens for the landing page. They use the dashboard's own
// markup, classes and shared components with sample content, so they look exactly like the app
// and follow its theme. The screen is inert and hidden from assistive technology; the figure
// caption describes it instead.
function Window({ title, caption, size, children }: { title: string; caption: string; size?: "tall" | "short"; children: ReactNode }) {
  return <figure className="replica">
    <div className="replica-bar" aria-hidden="true"><i /><i /><i /><span>{title}</span></div>
    <div className={`replica-screen${size ? ` ${size}` : ""}`} inert aria-hidden="true">{children}</div>
    <figcaption className="sr-only">{caption}</figcaption>
  </figure>;
}

const tabs = ["Analytics", "Chat", "Memory", "Pull Requests", "Settings"];
function Chrome({ active, secondary, children }: { active: string; secondary?: [string, boolean][]; children: ReactNode }) {
  return <div className="shell">
    <div className="portal-top">
      <div className="portal-identity">
        <span className="brand"><Mark /> OpenReview</span>
        <details className="scope-selector"><summary>Acme</summary></details>
        <details className="profile"><summary>@dana</summary></details>
      </div>
      <nav className="primary-nav">{tabs.map((t) => <a key={t} aria-current={t === active ? "page" : undefined}>{t}</a>)}</nav>
    </div>
    {secondary && <aside className="secondary-nav"><nav>{secondary.map(([label, current]) => <a key={label} aria-current={current ? "page" : undefined}>{label}</a>)}</nav></aside>}
    <div className="content">{children}</div>
  </div>;
}

function FixControl({ label = "Fix with AI" }: { label?: string }) {
  return <div className="fix-control"><form><select defaultValue="claude"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="cursor">Cursor Agent</option></select><button className="primary" type="button">{label}</button></form></div>;
}

// Pull request review page (app/dashboard/sections/reviews.tsx, detail view).
export function ReviewReplica() {
  return <Window title={`Pull Requests · ${pull.repo} #${pull.number}`} size="tall" caption={`The OpenReview pull request page for ${pull.repo} #${pull.number}: the reviewed diff with a critical finding shown inline at the changed line, and a confidence score of ${score.value} out of 5.`}>
    <Chrome active="Pull Requests" secondary={[["All Pull Requests", true], ["Findings", false]]}>
      <header><div><p className="muted">Acme</p><h1>Pull Requests</h1></div><span className="live">Updating automatically</span></header>
      <div className="row"><h2>{pull.repo} #{pull.number}</h2>{status("completed")}</div>
      <p className="muted repository-identity">{pull.provider}</p>
      <p className="muted">Reviewed revision {pull.head} · {pull.reviewedAt}</p>
      <p>{pull.title} · @{pull.author} · <a>View pull request</a></p>
      <p className="muted">{pull.headBranch} → {pull.baseBranch}</p>
      <section className="review-diff">
        <h2>Changes</h2>
        <p className="muted">Exact base…head comparison at {pull.head.slice(0, 12)} · {diffFiles.length} files</p>
        <DiffFiles files={diffFiles} findings={diffFindings} />
      </section>
      <section>
        <h2>Confidence score</h2>
        <p><strong>{score.value}/5</strong> · confidence that the change is safe to merge</p>
        <p>{score.reason}</p>
      </section>
    </Chrome>
  </Window>;
}

// A verified finding with its quoted evidence (review page, "Verified findings").
export function FindingReplica() {
  const f = findings[0];
  return <Window title={`${pull.repo} #${pull.number} · Verified findings`} size="short" caption="A verified critical finding with the file and line it depends on, its impact, three quoted lines of evidence and a suggested fix.">
    <div className="replica-pane">
      <section>
        <h2>Verified findings</h2>
        <FixControl label="Fix All" />
        <article>
          <h3>{status(f.severity)} {f.title}</h3>
          <p>{f.filePath}:{f.startLine} · {Math.round(f.confidence * 100)}% confidence · Verified at this revision · Current status: open</p>
          <p>{f.description}</p>
          <p>Impact: {f.impact}</p>
          {f.evidence.map((e) => <div key={`${e.filePath}:${e.startLine}`}><pre>{e.filePath}:{e.startLine}{"\n"}{e.quote}</pre></div>)}
          <p>Suggested fix: {f.suggestedFix}</p>
        </article>
      </section>
    </div>
  </Window>;
}

// The review summary kept on the pull request, and the review history.
export function SummaryReplica() {
  return <Window title={`${pull.repo} #${pull.number} · Review summary`} size="short" caption="The review summary: what changed, affected areas and a recommendation, followed by a history of reviews for each pushed revision.">
    <div className="replica-pane">
      <section>
        <div className="row"><h2>Review summary</h2><form><button type="button">Re-review current PR</button></form></div>
        <ReviewMarkdown>{summary}</ReviewMarkdown>
      </section>
      <section>
        <h2>Review history</h2>
        <ol className="timeline">{history.map((r) => <li key={r.sha}><a aria-current={r.current ? "page" : undefined}>{r.at} · {r.sha} · {r.status}</a><span>{r.findings} findings · Score {r.score}</span></li>)}</ol>
      </section>
    </div>
  </Window>;
}

// Codebase chat (app/dashboard/chat.tsx).
export function ChatReplica() {
  return <Window title="Chat" size="short" caption="Codebase chat: a question about where checkout totals are computed, answered with two citations that quote the indexed source.">
    <div className="replica-pane">
      <div className="chat-layout">
        <aside className="chat-threads"><a className="button">New chat</a><ul>{chat.threads.map((t, i) => <li key={t}><a aria-current={i === 0 ? "page" : undefined}>{t}</a></li>)}</ul></aside>
        <div className="chat-main">
          <section>
            <article className="chat-message user"><p className="muted">You · {chat.askedAt}</p><p className="chat-question">{chat.question}</p></article>
            <article className="chat-message assistant">
              <p className="muted">OpenReview · {chat.askedAt}</p>
              <ReviewMarkdown>{chat.answer}</ReviewMarkdown>
              <ol className="chat-citations">{chat.citations.map((c) => <li key={c.ref}><code>{c.ref}</code><span className="muted"> @ {pull.head.slice(0, 12)}</span><pre>{c.quote}</pre></li>)}</ol>
            </article>
          </section>
        </div>
      </div>
    </div>
  </Window>;
}

// Hand-off controls from the Findings page (app/dashboard/sections/findings.tsx).
export function AgentReplica() {
  const f = findings[0];
  return <Window title="Pull Requests · Findings" size="short" caption="A finding on the Findings page with controls to send it to Codex, Claude Code or Cursor Agent, copy a fix prompt, or open an agent with the prompt pre-filled.">
    <div className="replica-pane">
      <section className="finding">
        <div className="row"><h2>{f.title}</h2><div>{status(f.severity)} {status("open")}</div></div>
        <p className="muted">{pull.repo} #{pull.number} · {f.filePath}:{f.startLine} · {Math.round(f.confidence * 100)}% confidence</p>
        <p><strong>Suggested fix:</strong> {f.suggestedFix}</p>
        <FixControl />
        <button type="button">Copy fix prompt</button>
        <p className="agent-links"><a className="button small">Open in Cursor</a><a className="button small">Open in Claude Code</a><a className="button small">Open in Codex</a><span className="muted"> Opens your agent with the prompt pre-filled; nothing runs until you send it.</span></p>
        <details open><summary>Portable prompt for Codex, Claude Code, or Cursor</summary><pre>{fixPrompt}</pre></details>
      </section>
    </div>
  </Window>;
}

// Analytics (app/dashboard/portal.tsx, AnalyticsView and Trends).
export function AnalyticsReplica() {
  const max = Math.max(1, ...analytics.reviews);
  return <Window title="Analytics" caption="The analytics page: pull requests, reviews, verified findings and model cost for the period, daily review activity, findings by severity and a trend of reviews and findings per day.">
    <div className="replica-pane">
      <div className="metrics">{analytics.metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="analytics-grid">
        <section><h2>Review activity</h2><div className="activity-chart">{analytics.days.map((d, i) => <div key={d}><div style={{ height: `${Math.max(2, (analytics.reviews[i] / max) * 140)}px` }} /><small>{d}</small></div>)}</div></section>
        <section><h2>Findings by severity</h2>{analytics.severity.map(([s, n]) => <div className="stat-row" key={s}>{status(s)}<strong>{n}</strong></div>)}</section>
      </div>
      <section><LineChart title="Reviews and findings per day" labels={analytics.days} series={[{ label: "Reviews", values: analytics.reviews }, { label: "Findings", values: analytics.findings }, { label: "Addressed", values: analytics.addressed }]} /></section>
    </div>
  </Window>;
}
