"use client";
// Configuration steps: controls on the left, a live preview on the right that follows unsaved state.
import { useState, type ReactNode } from "react";
import { summaryLabels, summarySections, strictnessPresets } from "../../../src/review-settings";
import { categories, severities } from "../../../src/engine/types";
import { previewComments, sampleFindings, triggerTimeline } from "../../../src/onboarding-preview";
import { findingComment } from "../../../src/review-summary";
import { ReviewMarkdown } from "../markdown";
import { example, exampleSummary } from "../summary-example";
import { Stage } from "./art";
import { StepForm } from "./wizard-client";

type Settings = { summarySections?: string[]; commentStyle: string; severityThreshold: string; minimumConfidence: number; maxComments: number; strictness?: number; categories: string[];
  automatic: boolean; drafts: boolean; rereview: boolean; triggerLabels?: string[]; threadReplies?: boolean; securityScan?: boolean; fixPullRequests?: boolean; mode: string };
type Action = (state: { error?: string }, form: FormData) => Promise<{ error?: string }>;
type Props = { action: Action; organizationId: string; defaults: Settings; admin: boolean; progress: ReactNode; heading: ReactNode };

function Shell({ action, organizationId, admin, progress, heading, step, children }: Omit<Props, "defaults"> & { step: string; children: ReactNode }) {
  return <div className="wizard-panel">{progress}{heading}
    <StepForm action={action} disabled={!admin}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="step" value={step} />{children}</StepForm>
  </div>;
}
// value: what a checked switch submits (a list entry such as a summary section); plain flags send "on".
function Toggle({ name, value, label, hint, checked, onChange }: { name: string; value?: string; label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return <li className="wizard-toggle"><label><span><strong>{label}</strong><span className="muted">{hint}</span></span>
    <input type="checkbox" role="switch" className="switch" name={name} value={value} checked={checked} onChange={(e) => onChange(e.target.checked)} /></label></li>;
}
function Window({ title, children }: { title: string; children: ReactNode }) {
  return <div className="wizard-window"><div className="wizard-window-bar"><span className="mono">{title}</span></div><div className="wizard-window-body">{children}</div></div>;
}
const Block = ({ on, children }: { on: boolean; children: ReactNode }) => <div className="preview-block" data-on={on}><div>{children}</div></div>;
const Bars = ({ widths }: { widths: number[] }) => <div className="preview-bars">{widths.map((w, i) => <span key={i} style={{ width: `${w}%` }} />)}</div>;

const sectionSketch: Record<string, ReactNode> = {
  overview: <Bars widths={[92, 78, 54]} />,
  affectedAreas: <div className="preview-table">{["src/total.ts", "tests/total.test.ts"].map((p) => <span key={p} className="mono">{p}</span>)}</div>,
  diagram: <div className="preview-sequence"><span>Checkout</span><i /><span>Totals</span><i /><span>Store</span></div>,
  findings: <div className="preview-table"><span><span className="badge high">P1</span> <span className="mono">src/total.ts:8</span></span></div>,
  requirements: <Bars widths={[66, 40]} />,
  score: <p className="preview-score mono">2/5 · fix before merging</p>,
  risk: <p className="mono muted">risk medium · confidence 90%</p>,
  resolved: <Bars widths={[48]} />, skipped: <p className="mono muted">package-lock.json · lower risk</p>, testSource: <Bars widths={[58]} />, tips: <Bars widths={[36]} />,
};

const sectionHints: Record<string, string> = {
  overview: "What the change does, in a few sentences.",
  affectedAreas: "Each changed file with a one-line summary.",
  diagram: "A sequence diagram of the changed flow, when one helps.",
  findings: "Verified issues by priority, linked to their lines.",
  requirements: "How the change meets criteria from linked tickets.",
  score: "A 0–5 merge confidence score with its reason.",
  risk: "Overall risk and how confident the review is.",
  resolved: "Findings from earlier reviews that are now fixed.",
  skipped: "Files the review left out, and why.",
  testSource: "Test files in the change; not a coverage measure.",
  tips: "A one-line feature tip under the summary.",
};
export function SummaryStep(props: Props) {
  const [sections, setSections] = useState<string[]>(props.defaults.summarySections ?? []);
  const [style, setStyle] = useState(props.defaults.commentStyle);
  const [exact, setExact] = useState(false);
  return <>
    <Shell {...props} step="summary">
      <ul className="wizard-toggles">{summarySections.map((s) => <Toggle key={s} name="summarySections" value={s} label={summaryLabels[s]} hint={sectionHints[s]}
        checked={sections.includes(s)} onChange={(on) => setSections(summarySections.filter((x) => x === s ? on : sections.includes(x)))} />)}</ul>
      <fieldset className="wizard-choice"><legend>Inline comment style</legend>
        {["concise", "detailed"].map((v) => <label key={v} className="check"><input type="radio" name="commentStyle" value={v} checked={style === v} onChange={() => setStyle(v)} />{v === "concise" ? "Concise: the problem and the fix" : "Detailed: adds impact and evidence"}</label>)}
      </fieldset>
      <details className="wizard-exact" open={exact} onToggle={(e) => setExact((e.target as HTMLDetailsElement).open)}><summary>Exact comment text for this example</summary>
        {exact && <div aria-live="polite"><ReviewMarkdown>{exampleSummary(sections)}</ReviewMarkdown><ReviewMarkdown>{findingComment(example, style)}</ReviewMarkdown></div>}</details>
    </Shell>
    <Stage caption={`${sections.filter((s) => s !== "tips").length} summary sections · ${style} comments`}>
      <Window title="acme/shop · pull request #42">
        <div className="preview-comment"><p className="preview-author"><strong>OpenReview</strong> <span className="muted">commented</span></p>
          {summarySections.map((s) => <Block key={s} on={sections.includes(s)}><p className="preview-heading">{summaryLabels[s]}</p>{sectionSketch[s]}</Block>)}
        </div>
        <div className="preview-comment inline"><p className="preview-author"><span className="mono">src/total.ts:8</span> <span className="badge high">P1</span></p><Bars widths={style === "detailed" ? [94, 88, 70, 52] : [90, 48]} /></div>
      </Window>
    </Stage>
  </>;
}

const presets = [{ value: 1, label: "Quiet", hint: "High severity, very confident only" }, { value: 2, label: "Balanced", hint: "Medium severity and up" }, { value: 3, label: "Thorough", hint: "Everything worth a look" }, { value: 0, label: "Custom", hint: "Set the thresholds yourself" }];
export function CommentsStep(props: Props) {
  const d = props.defaults;
  const [strictness, setStrictness] = useState(d.strictness ?? 0), [severity, setSeverity] = useState(d.severityThreshold), [confidence, setConfidence] = useState(d.minimumConfidence);
  const [chosen, setChosen] = useState<string[]>(d.categories), [max, setMax] = useState(d.maxComments);
  const outcomes = previewComments(sampleFindings, { strictness, severityThreshold: severity, minimumConfidence: confidence, categories: chosen, maxComments: max });
  const posted = outcomes.filter((o) => o.outcome === "posted").length;
  return <>
    <Shell {...props} step="comments">
      <fieldset className="wizard-segments"><legend>How much to flag</legend>
        {presets.map((p) => <label key={p.value} className={strictness === p.value ? "active" : undefined}><input type="radio" name="strictness" value={p.value} checked={strictness === p.value} onChange={() => setStrictness(p.value)} /><strong>{p.label}</strong><span className="muted">{p.hint}</span></label>)}
      </fieldset>
      {strictness === 0 ? <div className="form-grid">
        <label>Lowest severity<select name="severityThreshold" value={severity} onChange={(e) => setSeverity(e.target.value)}>{severities.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Minimum confidence<input type="number" name="minimumConfidence" min={0.5} max={1} step={0.05} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} /></label>
      </div> : <><input type="hidden" name="severityThreshold" value={severity} /><input type="hidden" name="minimumConfidence" value={confidence} />
        <p className="muted">{presets.find((p) => p.value === strictness)?.label}: {strictnessPresets[strictness as 1 | 2 | 3].severityThreshold} severity and up, confidence {strictnessPresets[strictness as 1 | 2 | 3].minimumConfidence} or more.</p></>}
      <fieldset className="wizard-categories"><legend>Categories</legend>
        {categories.map((c) => <label key={c} className="check"><input type="checkbox" name="categories" value={c} checked={chosen.includes(c)} onChange={(e) => setChosen(categories.filter((x) => x === c ? e.target.checked : chosen.includes(x)))} />{c}</label>)}
      </fieldset>
      <label>Most inline comments per review<input type="number" name="maxComments" min={0} max={30} value={max} onChange={(e) => setMax(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} /></label>
    </Shell>
    <Stage caption={`${posted} of ${outcomes.length} example findings would post inline`}>
      <Window title="example change · 6 verified findings">
        <ul className="preview-findings">{outcomes.map((f) => <li key={f.id} data-posted={f.outcome === "posted"}>
          <span className={`badge ${f.severity}`}>{f.severity}</span><span className="preview-title">{f.title}<span className="mono muted">{f.path}:{f.line} · {f.category} · {Math.round(f.confidence * 100)}%</span></span>
          <span className={`badge ${f.outcome === "posted" ? "completed" : "queued"}`}>{f.outcome === "posted" ? "posts" : f.outcome}</span>
        </li>)}</ul>
      </Window>
    </Stage>
  </>;
}

export function TriggersStep(props: Props) {
  const d = props.defaults;
  const [s, setS] = useState({ automatic: d.automatic, drafts: d.drafts, rereview: d.rereview, threadReplies: d.threadReplies ?? true, labels: (d.triggerLabels ?? []).join(", ") });
  const set = (key: keyof typeof s) => (value: boolean) => setS({ ...s, [key]: value });
  const timeline = triggerTimeline({ ...s, triggerLabels: s.labels.split(",").map((l) => l.trim()).filter(Boolean) });
  return <>
    <Shell {...props} step="triggers">
      <ul className="wizard-toggles">
        <Toggle name="automatic" label="Review new pull requests" hint="Review automatically when a pull request opens or is marked ready." checked={s.automatic} onChange={set("automatic")} />
        <Toggle name="rereview" label="Re-review new commits" hint="Review again when new commits are pushed." checked={s.rereview} onChange={set("rereview")} />
        <Toggle name="drafts" label="Include drafts" hint="Also review draft pull requests." checked={s.drafts} onChange={set("drafts")} />
        <Toggle name="threadReplies" label="Answer replies" hint="Reply in OpenReview threads without needing an @openreview mention." checked={s.threadReplies} onChange={set("threadReplies")} />
      </ul>
      <label>Trigger labels <span className="muted">Comma-separated; adding one starts a review even when automatic reviews are off.</span>
        <input name="triggerLabels" value={s.labels} onChange={(e) => setS({ ...s, labels: e.target.value })} placeholder="needs-review" /></label>
    </Shell>
    <Stage caption={`${timeline.filter((e) => e.review).length} of ${timeline.length} example events start a review`}>
      <Window title="pull request #42 · timeline">
        <ol className="preview-timeline">{timeline.map((e) => <li key={e.id} data-review={e.review}><span className="preview-dot" /><span className="preview-title">{e.label}<span className="muted">{e.reason}</span></span>
          <span className={`badge ${e.review ? "completed" : "queued"}`}>{e.review ? (e.id === "reply" ? "answers" : "reviews") : "skipped"}</span></li>)}</ol>
      </Window>
    </Stage>
  </>;
}

const agents = [["claude", "Claude Code"], ["codex", "Codex"], ["cursor", "Cursor"]] as const;
export function ToolsStep(props: Props & { agent?: string }) {
  const d = props.defaults;
  const [security, setSecurity] = useState(d.securityScan ?? true), [fixPrs, setFixPrs] = useState(d.fixPullRequests ?? false), [agent, setAgent] = useState(props.agent ?? "claude"), [mode, setMode] = useState(d.mode);
  const agentName = agents.find(([v]) => v === agent)?.[1] ?? "your agent";
  return <>
    <Shell {...props} step="tools">
      <label>Default coding agent<select name="agent" value={agent} onChange={(e) => setAgent(e.target.value)}>{agents.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
      <ul className="wizard-toggles">
        <Toggle name="securityScan" label="Security checks" hint="Pattern checks on added lines and advisory lookups for changed dependencies." checked={security} onChange={setSecurity} />
        <Toggle name="fixPullRequests" label="Fix pull requests" hint="“@openreview fix this in a new PR” opens a branch. Needs the App’s Contents: write permission." checked={fixPrs} onChange={setFixPrs} />
      </ul>
      <label>Review depth<select name="mode" value={mode} onChange={(e) => setMode(e.target.value)}><option value="fast">Fast</option><option value="standard">Standard</option><option value="deep">Deep</option></select></label>
    </Shell>
    <Stage caption={`fix with ${agentName}${security ? " · security checks on" : ""}${fixPrs ? " · fix pull requests on" : ""}`}>
      <Window title="src/total.ts · finding">
        <div className="preview-comment inline"><p className="preview-author"><span className="badge high">P1</span> Keep totals in integer cents</p><Bars widths={[88, 52]} />
          <p className="preview-actions"><span className="button small primary">Fix with {agentName}</span><span className="button small">Copy prompt</span></p></div>
        <Block on={security}><div className="preview-comment inline"><p className="preview-author"><span className="badge medium">security</span> <span className="mono">package.json</span></p><p className="mono muted">example advisory · upgrade to the fixed version</p></div></Block>
        <Block on={fixPrs}><div className="preview-thread"><p><span className="mono">@dev</span> @openreview fix this in a new PR</p><p><strong>OpenReview</strong> opened <span className="mono">openreview/fix-integer-cents</span></p></div></Block>
      </Window>
    </Stage>
  </>;
}
