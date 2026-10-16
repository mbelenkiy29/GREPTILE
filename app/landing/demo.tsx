"use client";
// Interactive replicas of real dashboard screens for the landing page. They reuse the dashboard's
// markup, classes and shared components with sample content, so they look like the app and follow
// its theme, and a visitor can click through them. Nothing here calls the backend: every result is
// sample data, and slow work (reviews, chat answers, agent hand-offs) is simulated with timers.
// Markdown and the configuration previews are rendered on the server (replicas.tsx) and passed in.
import { createElement, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { DiffFiles, type DiffFile, type DiffFinding } from "../dashboard/diff-files";
import { PortalDisclosure } from "../dashboard/portal-disclosure";
import { priority, status } from "../dashboard/sections/shared";
import { reviewVerdict, verdictLabels } from "../../src/verdict";
import { LineChart } from "../ui/charts";
import { Mark } from "../ui/logo";
import { analyticsView, answerFor, revealWords, triggerFlags, triggerKey, wordCount } from "./demo-logic";
import { agents, analytics, chat, diffFiles, diffFindings, findings, fixPrompt, fixPush, fixStatuses, history, indexed, memory, otherPulls, pull, score, sources, type Revision } from "./sample";

export type CommentPreview = { id: string; title: string; path: string; line: number; severity: string; category: string; confidence: number; outcome: string };
export type TriggerPreview = { id: string; label: string; review: boolean; reason: string };
export type SettingsPreviews = { comments: Record<string, CommentPreview[]>; triggers: Record<string, TriggerPreview[]> };

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)"), update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}
/** Runs steps after cumulative delays. Starting a new run, or unmounting, cancels pending steps. */
function useSchedule() {
  const timers = useRef<number[]>([]);
  const cancel = useCallback(() => { timers.current.forEach(clearTimeout); timers.current = []; }, []);
  useEffect(() => cancel, [cancel]);
  return useCallback((steps: [delay: number, run: () => void][]) => {
    cancel();
    let at = 0;
    for (const [delay, run] of steps) { at += delay; timers.current.push(window.setTimeout(run, at)); }
  }, [cancel]);
}

/** Plays `play` once, shortly after the window is half in view, unless the visitor prefers reduced
 *  motion. A click or key press inside the window first cancels it: the visitor is driving. */
function useAutoplay(frame: RefObject<HTMLElement | null>, play?: () => void) {
  const latest = useRef(play), enabled = Boolean(play);
  useEffect(() => { latest.current = play; });
  useEffect(() => {
    const el = frame.current;
    if (!enabled || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    const observer = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (entry.isIntersecting) timer = window.setTimeout(() => { stop(); latest.current?.(); }, 800);
    }, { threshold: 0.5 });
    const stop = () => { clearTimeout(timer); observer.disconnect(); el.removeEventListener("pointerdown", stop); el.removeEventListener("keydown", stop); };
    observer.observe(el);
    el.addEventListener("pointerdown", stop);
    el.addEventListener("keydown", stop);
    return stop;
  }, [frame, enabled]);
}

// Headings keep the app's look but stay out of the landing page's outline.
const H = ({ level = 2, children }: { level?: 1 | 2 | 3; children: ReactNode }) => createElement(`h${level}`, { role: "presentation" }, children);

function Window({ title, caption, size, frame, children }: { title: string; caption: string; size?: "tall" | "short"; frame?: RefObject<HTMLElement | null>; children: ReactNode }) {
  return <figure className="replica" ref={frame}>
    <div className="replica-bar" aria-hidden="true"><i /><i /><i /><span>{title}</span><em>Demo</em></div>
    <div className={`replica-screen${size ? ` ${size}` : ""}`}>{children}</div>
    <figcaption className="sr-only">Interactive demo with sample data. {caption}</figcaption>
  </figure>;
}

const tabs = ["Analytics", "Chat", "Memory", "Pull Requests", "Settings"] as const;
type Tab = (typeof tabs)[number];
type Nav = [label: string, current: boolean, open: () => void][];
function Chrome({ active, onTab, secondary, children }: { active: Tab; onTab: (tab: Tab) => void; secondary?: Nav; children: ReactNode }) {
  return <div className="shell">
    <div className="portal-top">
      <div className="portal-identity">
        <span className="brand"><Mark /> OpenReview</span>
        <PortalDisclosure className="scope-selector" label="Acme"><div className="scope-menu"><p className="muted">Acme is a sample workspace.</p><a href="/signup">Create your workspace →</a></div></PortalDisclosure>
        <PortalDisclosure className="profile" label="@dana"><div className="profile-menu"><a href="/login">Sign in</a><a href="/signup">Create an account</a></div></PortalDisclosure>
      </div>
      <nav className="primary-nav" aria-label="Demo sections">{tabs.map((t) => <button key={t} type="button" aria-current={t === active ? "page" : undefined} onClick={() => onTab(t)}>{t}</button>)}</nav>
    </div>
    {secondary && <aside className="secondary-nav"><nav aria-label={`${active} pages`}>{secondary.map(([label, current, open]) => <button key={label} type="button" aria-current={current ? "page" : undefined} onClick={open}>{label}</button>)}</nav></aside>}
    <div className="content">{children}</div>
  </div>;
}
const PageHeader = ({ title }: { title: string }) => <header><div><p className="muted">Acme</p><H level={1}>{title}</H></div><span className="live">Updating automatically</span></header>;

// ---------- Pull requests ----------
type Pull = { number: number; title: string; author: string; head: string; headBranch: string; reviewedAt: string; state: string; files: DiffFile[]; found: DiffFinding[]; score?: { value: number; reason: string }; steps?: string[] };
const pulls: Pull[] = [
  { ...pull, state: "completed", files: diffFiles, found: diffFindings, score },
  ...otherPulls.map((p) => ({ ...p, state: p.status, files: p.files ?? [], found: [] })),
];
type PullsView = "list" | "findings" | number;

function PullTable({ open }: { open: (n: number) => void }) {
  return <section><div className="table-scroll"><table><thead><tr><th>Pull request</th><th>Author</th><th>Latest review</th><th>Findings</th><th>Score</th></tr></thead><tbody>
    {pulls.map((p) => <tr key={p.number}>
      <td><button type="button" className="pull-link" onClick={() => open(p.number)}><span>{pull.repo} #{p.number}</span><small>{p.title}</small></button></td>
      <td>@{p.author}</td><td>{status(p.state)}</td><td>{p.score ? p.found.length : "—"}</td><td>{p.score ? `${p.score.value}/5` : "—"}</td>
    </tr>)}
  </tbody></table></div></section>;
}

function PullDetail({ p }: { p: Pull }) {
  const verdict = p.score && reviewVerdict({ score: p.score.value, findings: p.found as unknown as Parameters<typeof reviewVerdict>[0]["findings"] });
  return <>
    <div className="row"><H level={2}>{pull.repo} #{p.number}</H>{status(p.state)}</div>
    <p className="muted repository-identity">{pull.provider}</p>
    {p.reviewedAt && <p className="muted">Reviewed revision {p.head} · {p.reviewedAt}</p>}
    <p>{p.title} · @{p.author}</p>
    <p className="muted">{p.headBranch} → {pull.baseBranch}</p>
    {p.steps ? <section><H level={2}>Review in progress</H><div className="chat-progress" role="status"><p className="muted">Working…</p><ol>{p.steps.map((s) => <li key={s}>{s}</li>)}</ol></div></section> : <>
      <section className="review-diff">
        <H level={2}>Changes</H>
        <p className="muted">Exact base…head comparison at {p.head.slice(0, 12)} · {p.files.length} file{p.files.length === 1 ? "" : "s"}</p>
        <DiffFiles files={p.files} findings={p.found} />
      </section>
      {verdict && <section><H level={2}>Verdict</H><p><strong>{verdictLabels[verdict]}</strong> · computed from the score, unresolved findings and review coverage</p></section>}
      {p.score && <section><H level={2}>Confidence score</H><p><strong>{p.score.value}/5</strong> · confidence that the change is safe to merge</p><p>{p.score.reason}</p></section>}
    </>}
  </>;
}

// ---------- Findings and fixes ----------
const agentName = (value: string) => agents.find(([v]) => v === value)?.[1] ?? value;
/** The dashboard's Fix button, with the bridge hand-off simulated. */
function FixControl({ label = "Fix with AI" }: { label?: string }) {
  const id = useId(), schedule = useSchedule();
  const [agent, setAgent] = useState("claude"), [preparing, setPreparing] = useState(false), [step, setStep] = useState(-1);
  const start = (e: FormEvent) => {
    e.preventDefault();
    setPreparing(true);
    setStep(-1);
    schedule([[500, () => { setPreparing(false); setStep(0); }], [900, () => setStep(1)], [900, () => setStep(2)], [1500, () => setStep(3)]]);
  };
  return <div className="fix-control">
    <form onSubmit={start}><label className="sr-only" htmlFor={id}>Coding agent</label><select id={id} value={agent} onChange={(e) => setAgent(e.target.value)}>{agents.map(([v, name]) => <option key={v} value={v}>{name}</option>)}</select><button className="primary" disabled={preparing}>{preparing ? "Preparing…" : label}</button></form>
    {step >= 0 && <p role="status">{fixStatuses[step]} <span className="muted">Simulated: in the app, {agentName(agent)} runs on your machine through the bridge. This does not mark the issue resolved.</span></p>}
  </div>;
}

type Finding = (typeof findings)[number];
/** A finding as the Findings page shows it, with the hand-off controls. */
function FindingCard({ f, full }: { f: Finding; full?: boolean }) {
  const [note, setNote] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(fixPrompt); setNote("Fix prompt copied."); }
    catch { setNote("Copy is blocked in this browser; select the prompt below instead."); }
  };
  return <section className="finding">
    <div className="row"><H level={2}>{f.title}</H><div>{priority(f)} {status("open")}</div></div>
    <p className="muted">{pull.repo} #{pull.number} · {f.filePath}:{f.startLine} · {Math.round(f.confidence * 100)}% confidence</p>
    <p><strong>Suggested fix:</strong> {f.suggestedFix}</p>
    <FixControl />
    {full && <>
      <button type="button" onClick={copy}>Copy fix prompt</button>
      <p className="agent-links">{agents.map(([v, name]) => <button key={v} type="button" className="button small" onClick={() => setNote(`Simulated: in the app, this opens ${name === "Cursor Agent" ? "Cursor" : name}.`)}>Open in {name === "Cursor Agent" ? "Cursor" : name}</button>)}<span className="muted"> Opens your agent with the prompt pre-filled; nothing runs until you send it.</span></p>
      {note && <p role="status" className="muted">{note}</p>}
      <details open><summary>Portable prompt for Codex, Claude Code, or Cursor</summary><pre>{fixPrompt}</pre></details>
    </>}
  </section>;
}

/** A quoted line shown in its file at the reviewed revision. */
function SourceView({ path, line }: { path: string; line: number }) {
  return <div className="source-view">
    <p className="muted">{path} at {pull.head.slice(0, 12)} · line {line} matches the quote</p>
    <div className="table-scroll"><table className="diff-table"><tbody>
      {(sources[path] ?? []).map((text, i) => <tr key={i} className={i + 1 === line ? "source-quoted" : undefined}><td className="diff-num">{i + 1}</td><td><code>{text || " "}</code></td></tr>)}
    </tbody></table></div>
  </div>;
}

function VerifiedFinding({ f, open: initial }: { f: Finding; open?: boolean }) {
  const [shown, setShown] = useState<string | null>(null);
  return <details className="verified-finding" open={initial}>
    <summary>{priority(f)} {f.title}</summary>
    <p>{f.filePath}:{f.startLine} · {Math.round(f.confidence * 100)}% confidence · Verified at this revision · Current status: open</p>
    <p>{f.description}</p>
    <p>Impact: {f.impact}</p>
    {f.evidence.map((e) => {
      const key = `${e.filePath}:${e.startLine}`;
      return <div key={key} className="evidence">
        <pre>{key}{"\n"}{e.quote}</pre>
        <button type="button" className="small" aria-expanded={shown === key} onClick={() => setShown(shown === key ? null : key)}>{shown === key ? "Hide file" : "Show in file"}</button>
        {shown === key && <SourceView path={e.filePath} line={e.startLine} />}
      </div>;
    })}
    <p>Suggested fix: {f.suggestedFix}</p>
  </details>;
}

// ---------- Chat ----------
type Message = { id: number; role: "user" | "assistant"; text: string; at: string; answer?: number; steps?: string[]; progress?: number; shown?: number; done: boolean };
type Thread = { id: number; title: string; messages: Message[] };
const sampleThreads = (): Thread[] => chat.answers.map((a, i) => ({
  id: i, title: a.question,
  messages: [{ id: i * 2, role: "user", text: a.question, at: chat.askedAt, done: true }, { id: i * 2 + 1, role: "assistant", text: a.answer, at: chat.askedAt, answer: i, done: true }],
}));

function ChatPane({ answers, autoplay }: { answers: ReactNode[]; autoplay?: { frame: RefObject<HTMLElement | null>; question: string } }) {
  const reduced = useReducedMotion(), schedule = useSchedule(), next = useRef(100);
  const [threads, setThreads] = useState(sampleThreads), [current, setCurrent] = useState<number | null>(0), [draft, setDraft] = useState("");
  const thread = threads.find((t) => t.id === current);
  const busy = threads.some((t) => t.messages.some((m) => !m.done));
  // While an answer arrives, keep the window scrolled to it; only the demo window scrolls, never the page.
  const root = useRef<HTMLDivElement>(null), follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    const screen = root.current?.closest(".replica-screen");
    screen?.scrollTo({ top: screen.scrollHeight });
    if (!busy) follow.current = false;
  }, [threads, busy]);
  const patch = (threadId: number, messageId: number, change: Partial<Message>) =>
    setThreads((list) => list.map((t) => t.id !== threadId ? t : { ...t, messages: t.messages.map((m) => m.id === messageId ? { ...m, ...change } : m) }));
  const ask = (question: string) => {
    const text = question.trim();
    if (busy || text.length < 2) return;
    const match = answerFor(text), index = match ? chat.answers.indexOf(match) : undefined;
    const threadId = thread?.id ?? next.current++, user = next.current++, reply = next.current++;
    const steps = match?.steps ?? ["Searching acme/shop for matching code"], body = match?.answer ?? chat.fallback;
    const messages: Message[] = [{ id: user, role: "user", text, at: "Just now", done: true }, { id: reply, role: "assistant", text: body, at: "Just now", answer: index, steps, progress: 0, shown: 0, done: false }];
    setThreads((list) => thread ? list.map((t) => t.id === threadId ? { ...t, messages: [...t.messages, ...messages] } : t) : [{ id: threadId, title: text, messages }, ...list]);
    setCurrent(threadId);
    setDraft("");
    follow.current = true;
    const words = wordCount(body), chunk = 3;
    schedule([
      ...steps.map((_, i): [number, () => void] => [550, () => patch(threadId, reply, { progress: i + 1 })]),
      ...(reduced ? [] : Array.from({ length: Math.ceil(words / chunk) }, (_, i): [number, () => void] => [i === 0 ? 400 : 45, () => patch(threadId, reply, { shown: (i + 1) * chunk })])),
      [reduced ? 400 : 120, () => patch(threadId, reply, { done: true })],
    ]);
  };
  useAutoplay(autoplay?.frame ?? root, autoplay && (() => ask(autoplay.question)));
  return <div className="chat-layout" ref={root}>
    <aside className="chat-threads" aria-label="Chat threads">
      <button type="button" className="button" onClick={() => setCurrent(null)}>New chat</button>
      <ul>{threads.map((t) => <li key={t.id}><button type="button" aria-current={t.id === current ? "page" : undefined} onClick={() => setCurrent(t.id)}>{t.title}</button></li>)}</ul>
    </aside>
    <div className="chat-main">
      {thread ? <section aria-label="Conversation">{thread.messages.map((m) => <article key={m.id} className={`chat-message ${m.role}`}>
        <p className="muted">{m.role === "user" ? "You" : "OpenReview"} · {m.at}{!m.done && <> · <span className="badge running">running</span></>}</p>
        {m.role === "user" ? <p className="chat-question">{m.text}</p>
          : !m.done && !m.shown ? <div className="chat-progress" role="status" aria-live="polite"><p className="muted">Working…</p><ol>{m.steps!.slice(0, Math.max(1, m.progress ?? 0)).map((s) => <li key={s}>{s}</li>)}</ol></div>
          : !m.done ? <p aria-hidden="true">{revealWords(m.text, m.shown ?? 0)}</p>
          : <div role="status" aria-live="polite">
            {m.answer === undefined ? <p>{m.text}</p> : answers[m.answer]}
            {m.answer !== undefined && <ol className="chat-citations" aria-label="Citations">{chat.answers[m.answer].citations.map((c) => <li key={c.ref}><code>{c.ref}</code><span className="muted"> @ {indexed.slice(0, 12)}</span><pre>{c.quote}</pre></li>)}</ol>}
          </div>}
      </article>)}</section>
        : <p className="muted">Ask about acme/shop. Answers are investigated with read-only code tools, and every claim cites lines at the indexed revision {indexed.slice(0, 12)}.</p>}
      <form className="form-grid chat-form" onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
        <label className="wide">{thread ? "Follow-up question" : "Question"}<textarea rows={2} maxLength={400} value={draft} placeholder="Which tests cover charge()?" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); } }} /></label>
        <button disabled={busy || draft.trim().length < 2}>{busy ? "Answering…" : "Ask"}</button>
      </form>
      <div className="demo-suggestions"><span className="muted">Try</span>{chat.answers.map((a) => <button key={a.question} type="button" className="small" disabled={busy} onClick={() => ask(a.question)}>{a.question}</button>)}</div>
    </div>
  </div>;
}

// ---------- Analytics ----------
function AnalyticsPane() {
  const ids = useId();
  const [days, setDays] = useState(14), [repository, setRepository] = useState("all"), [day, setDay] = useState<number | null>(null);
  const [series, setSeries] = useState(["Reviews", "Findings", "Addressed"]);
  const v = analyticsView(days, repository), max = Math.max(1, ...v.reviews), at = day ?? v.days.length - 1;
  const lines = [{ label: "Reviews", values: v.reviews }, { label: "Findings", values: v.findings }, { label: "Addressed", values: v.addressed }];
  return <>
    <div className="filter-bar">
      <label htmlFor={`${ids}-repo`}>Repository<select id={`${ids}-repo`} value={repository} onChange={(e) => setRepository(e.target.value)}><option value="all">All repositories</option>{Object.keys(analytics.repositories).map((r) => <option key={r}>{r}</option>)}</select></label>
      <label htmlFor={`${ids}-days`}>Period<select id={`${ids}-days`} value={days} onChange={(e) => { setDays(Number(e.target.value)); setDay(null); }}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option></select></label>
    </div>
    <div className="metrics">{v.metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="analytics-grid">
      <section>
        <H level={2}>Review activity</H>
        <p className="demo-readout" aria-live="polite">{v.days[at]} · {v.reviews[at]} review{v.reviews[at] === 1 ? "" : "s"} · {v.findings[at]} finding{v.findings[at] === 1 ? "" : "s"}</p>
        <div className="activity-chart" onMouseLeave={() => setDay(null)}>{v.days.map((d, i) => <div key={d} data-active={day === i || undefined} onMouseEnter={() => setDay(i)}><div style={{ height: `${Math.max(2, (v.reviews[i] / max) * 140)}px` }} /><small>{d}</small></div>)}</div>
      </section>
      <section><H level={2}>Findings by severity</H>{v.severity.map(([s, n]) => <div className="stat-row" key={s}>{status(s)}<strong>{n}</strong></div>)}</section>
    </div>
    <section>
      <fieldset className="demo-series"><legend className="sr-only">Series</legend>{lines.map((l) => <label key={l.label} className="check"><input type="checkbox" checked={series.includes(l.label)} onChange={(e) => setSeries(lines.map((x) => x.label).filter((x) => x === l.label ? e.target.checked : series.includes(x)))} />{l.label}</label>)}</fieldset>
      <LineChart title="Reviews and findings per day" labels={v.days} series={lines.filter((l) => series.includes(l.label))} />
    </section>
  </>;
}

// ---------- Memory ----------
function MemoryPane({ view }: { view: "rules" | "preferences" }) {
  const [rules, setRules] = useState(memory.rules), [off, setOff] = useState<string[]>([]);
  const toggle = (id: string, on: boolean) => setRules(rules.map((r) => r.id === id ? { ...r, on } : r));
  return view === "rules" ? <section>
    <div className="row"><H level={2}>Custom rules</H><span className="muted" aria-live="polite">{rules.filter((r) => r.on).length} of {rules.length} on</span></div>
    <p className="muted">Rules are checked on every review, alongside the rules in .openreview.json.</p>
    <ul className="wizard-toggles">{rules.map((r) => <li key={r.id} className="wizard-toggle"><label><span><strong>{r.title}</strong><span className="muted">{r.body}</span><span className="mono muted">{r.scope} · added by @{r.by}</span></span>
      <input type="checkbox" role="switch" className="switch" checked={r.on} onChange={(e) => toggle(r.id, e.target.checked)} /></label></li>)}</ul>
  </section> : <section>
    <H level={2}>Learned preferences</H>
    <p className="muted">Learned from reactions and recurring review comments. They reduce repeat comments, and never weaken security review or approve pull requests.</p>
    <ul className="wizard-toggles">{memory.preferences.map((p) => <li key={p.id} className="wizard-toggle"><label><span><strong>{p.text}</strong><span className="muted">{p.source}</span></span>
      <input type="checkbox" role="switch" className="switch" checked={!off.includes(p.id)} onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== p.id) : [...off, p.id])} /></label></li>)}</ul>
  </section>;
}

// ---------- Settings ----------
const presets = [{ value: "1", label: "Quiet", hint: "High severity, very confident only" }, { value: "2", label: "Balanced", hint: "Medium severity and up" }, { value: "3", label: "Thorough", hint: "Everything worth a look" }];
const triggerToggles: [key: (typeof triggerFlags)[number], label: string, hint: string][] = [["automatic", "Review new pull requests", "When a pull request opens or is marked ready."], ["rereview", "Re-review new commits", "When new commits are pushed."], ["drafts", "Include drafts", "Also review draft pull requests."], ["threadReplies", "Answer replies", "Reply in OpenReview threads without an @openreview mention."]];

function SettingsPane({ view, previews }: { view: "comments" | "triggers"; previews: SettingsPreviews }) {
  const [strictness, setStrictness] = useState("2"), [on, setOn] = useState<Record<string, boolean>>({ automatic: true, rereview: true, drafts: false, threadReplies: true });
  const name = useId();
  if (view === "comments") {
    const outcomes = previews.comments[strictness] ?? [];
    return <section>
      <H level={2}>Review comments</H>
      <fieldset className="wizard-segments"><legend>How much to flag</legend>
        {presets.map((p) => <label key={p.value} className={strictness === p.value ? "active" : undefined}><input type="radio" name={name} value={p.value} checked={strictness === p.value} onChange={() => setStrictness(p.value)} /><strong>{p.label}</strong><span className="muted">{p.hint}</span></label>)}
      </fieldset>
      <p className="demo-readout" aria-live="polite">{outcomes.filter((o) => o.outcome === "posted").length} of {outcomes.length} example findings would post inline</p>
      <ul className="preview-findings">{outcomes.map((f) => <li key={f.id} data-posted={f.outcome === "posted"}>
        <span className={`badge ${f.severity}`}>{f.severity}</span><span className="preview-title">{f.title}<span className="mono muted">{f.path}:{f.line} · {f.category} · {Math.round(f.confidence * 100)}%</span></span>
        <span className={`badge ${f.outcome === "posted" ? "completed" : "queued"}`}>{f.outcome === "posted" ? "posts" : f.outcome}</span>
      </li>)}</ul>
    </section>;
  }
  const timeline = previews.triggers[triggerKey(on)] ?? [];
  return <section>
    <H level={2}>Triggers</H>
    <ul className="wizard-toggles">{triggerToggles.map(([key, label, hint]) => <li key={key} className="wizard-toggle"><label><span><strong>{label}</strong><span className="muted">{hint}</span></span>
      <input type="checkbox" role="switch" className="switch" checked={on[key]} onChange={(e) => setOn({ ...on, [key]: e.target.checked })} /></label></li>)}</ul>
    <p className="demo-readout" aria-live="polite">{timeline.filter((e) => e.review).length} of {timeline.length} example events start a review</p>
    <ol className="preview-timeline">{timeline.map((e) => <li key={e.id} data-review={e.review}><span className="preview-dot" /><span className="preview-title">{e.label}<span className="muted">{e.reason}</span></span>
      <span className={`badge ${e.review ? "completed" : "queued"}`}>{e.review ? (e.id === "reply" ? "answers" : "reviews") : "skipped"}</span></li>)}</ol>
  </section>;
}

// ---------- The hero: the whole app ----------
export function AppDemo({ answers, previews }: { answers: ReactNode[]; previews: SettingsPreviews }) {
  const [tab, setTab] = useState<Tab>("Pull Requests"), [visited, setVisited] = useState<Tab[]>(["Pull Requests"]);
  const [pullsView, setPulls] = useState<PullsView>(pull.number), [memoryView, setMemory] = useState<"rules" | "preferences">("rules"), [settingsView, setSettings] = useState<"comments" | "triggers">("comments");
  const open = (t: Tab) => { setTab(t); setVisited((v) => v.includes(t) ? v : [...v, t]); };
  const detail = typeof pullsView === "number" ? pulls.find((p) => p.number === pullsView) : undefined;
  const secondary: Partial<Record<Tab, Nav>> = {
    "Pull Requests": [["All Pull Requests", pullsView !== "findings", () => setPulls("list")], ["Findings", pullsView === "findings", () => setPulls("findings")]],
    Memory: [["Custom rules", memoryView === "rules", () => setMemory("rules")], ["Learned preferences", memoryView === "preferences", () => setMemory("preferences")]],
    Settings: [["Review comments", settingsView === "comments", () => setSettings("comments")], ["Triggers", settingsView === "triggers", () => setSettings("triggers")]],
  };
  const panes: Record<Tab, ReactNode> = {
    "Pull Requests": detail ? <PullDetail p={detail} /> : pullsView === "findings" ? findings.map((f) => <FindingCard key={f._id} f={f} />) : <PullTable open={setPulls} />,
    Chat: <ChatPane answers={answers} />,
    Analytics: <AnalyticsPane />,
    Memory: <MemoryPane view={memoryView} />,
    Settings: <SettingsPane view={settingsView} previews={previews} />,
  };
  const title = tab === "Pull Requests" ? (detail ? `Pull Requests · ${pull.repo} #${detail.number}` : pullsView === "findings" ? "Pull Requests · Findings" : "Pull Requests") : tab;
  return <Window title={title} size="tall" caption={`The OpenReview dashboard for a sample workspace, open at ${pull.repo} #${pull.number}: the reviewed diff with a P0 finding inline at the changed line, a "Needs changes" verdict and a confidence score of ${score.value} out of 5. Use the section buttons to open Analytics, Chat, Memory and Settings.`}>
    <Chrome active={tab} onTab={open} secondary={secondary[tab]}>
      <PageHeader title={tab} />
      {tabs.filter((t) => visited.includes(t)).map((t) => <div key={t} className="demo-pane" hidden={t !== tab}>{panes[t]}</div>)}
    </Chrome>
  </Window>;
}

// ---------- Feature demos ----------
export function EvidenceDemo() {
  return <Window title={`${pull.repo} #${pull.number} · Verified findings`} size="short" caption="Verified findings with the file and line each depends on, its impact, quoted evidence that can be shown in place in the file, and a suggested fix.">
    <div className="replica-pane"><section>
      <H level={2}>Verified findings</H>
      <FixControl label="Fix All" />
      {findings.map((f, i) => <VerifiedFinding key={f._id} f={f} open={i === 0} />)}
    </section></div>
  </Window>;
}

export function SummaryDemo({ summaries }: { summaries: Record<string, ReactNode> }) {
  const schedule = useSchedule(), frame = useRef<HTMLElement>(null);
  const [revisions, setRevisions] = useState<Revision[]>(history), [selected, setSelected] = useState(history[0].sha);
  const [run, setRun] = useState<{ status: string; step: number } | null>(null);
  const reviewed = revisions.some((r) => r.sha === fixPush.sha);
  const rereview = () => {
    setRun({ status: "queued", step: 0 });
    schedule([
      [600, () => setRun({ status: "running", step: 1 })],
      ...fixPush.steps.slice(1).map((_, i): [number, () => void] => [650, () => setRun({ status: "running", step: i + 2 })]),
      [600, () => { setRun(null); setRevisions((list) => [fixPush.revision, ...list.filter((r) => r.sha !== fixPush.sha)]); setSelected(fixPush.sha); }],
    ]);
  };
  useAutoplay(frame, reviewed || run ? undefined : rereview);
  const shown = revisions.find((r) => r.sha === selected) ?? revisions[0];
  return <Window frame={frame} title={`${pull.repo} #${pull.number} · Review summary`} size="short" caption="The review summary for a pull request, with a button that re-reviews a newly pushed fix, and a history of reviews for each pushed revision.">
    <div className="replica-pane">
      <section>
        <div className="row"><H level={2}>Review summary</H><button type="button" disabled={run !== null} onClick={rereview}>{run ? "Reviewing…" : "Re-review current PR"}</button></div>
        {!reviewed && !run && <p className="muted">@{pull.author} pushed {fixPush.sha.slice(0, 7)}: {fixPush.message} · not reviewed yet</p>}
        {run ? <div className="chat-progress" role="status" aria-live="polite"><p className="muted">{status(run.status)} {fixPush.sha.slice(0, 12)}</p><ol>{fixPush.steps.slice(0, run.step).map((s) => <li key={s}>{s}</li>)}</ol></div>
          : <div aria-live="polite"><p className="muted">{shown.sha.slice(0, 12)} · {shown.findings} finding{shown.findings === 1 ? "" : "s"} · Score {shown.score}</p>{summaries[shown.sha]}</div>}
      </section>
      <section>
        <H level={2}>Review history</H>
        <ol className="timeline">{revisions.map((r) => <li key={r.sha}><button type="button" className="link-button" aria-current={r.sha === shown.sha ? "page" : undefined} onClick={() => setSelected(r.sha)}>{r.at} · {r.sha} · {r.status}</button><span>{r.findings} findings · Score {r.score}</span></li>)}</ol>
      </section>
    </div>
  </Window>;
}

export function ChatDemo({ answers }: { answers: ReactNode[] }) {
  const frame = useRef<HTMLElement>(null);
  return <Window frame={frame} title="Chat" size="short" caption="Codebase chat: pick a sample question or type one, watch the investigation steps, and read an answer whose citations quote the indexed source.">
    <div className="replica-pane"><ChatPane answers={answers} autoplay={{ frame, question: chat.answers[1].question }} /></div>
  </Window>;
}

export function AgentDemo() {
  return <Window title="Pull Requests · Findings" size="short" caption="A finding on the Findings page with controls to send it to Codex, Claude Code or Cursor Agent, copy a fix prompt, or open an agent with the prompt pre-filled.">
    <div className="replica-pane"><FindingCard f={findings[0]} full /></div>
  </Window>;
}

export function AnalyticsDemo() {
  return <Window title="Analytics" caption="The analytics page with repository and period filters: pull requests, reviews, verified findings and model cost, daily review activity, findings by severity and a trend of reviews and findings per day.">
    <div className="replica-pane"><AnalyticsPane /></div>
  </Window>;
}
