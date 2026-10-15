// Example data and pure logic behind the guided-setup previews. Previews react to unsaved form
// state in the browser, so this module stays free of server and Node-only dependencies.
import { severities } from "./engine/types";
import { effectiveThresholds } from "./review-settings";

type Severity = (typeof severities)[number];
export type PreviewFinding = { id: string; title: string; path: string; line: number; severity: Severity; category: string; confidence: number };
// Six example findings on one change, spread across severities, categories and confidence.
export const sampleFindings: readonly PreviewFinding[] = [
  { id: "refund", title: "Refund total ignores partial captures", path: "src/billing/refund.ts", line: 42, severity: "critical", category: "correctness", confidence: 0.97 },
  { id: "signature", title: "Webhook signature compared with ==", path: "src/webhooks/verify.ts", line: 18, severity: "high", category: "security", confidence: 0.93 },
  { id: "migration", title: "Column dropped before its backfill runs", path: "db/migrations/0042_currency.sql", line: 7, severity: "high", category: "data", confidence: 0.88 },
  { id: "export", title: "Exported helper renamed without an alias", path: "src/lib/money.ts", line: 3, severity: "medium", category: "compatibility", confidence: 0.86 },
  { id: "test", title: "New zero-quantity branch has no test", path: "src/cart/total.ts", line: 27, severity: "medium", category: "testing", confidence: 0.8 },
  { id: "rates", title: "Exchange rates fetched once per line item", path: "src/cart/total.ts", line: 31, severity: "low", category: "performance", confidence: 0.78 },
];
export type CommentSettings = { severityThreshold: string; minimumConfidence: number; strictness?: number; categories: readonly string[]; maxComments: number };
export type CommentOutcome = "posted" | "over limit" | "category off" | "low confidence" | "below severity";
/** Which example findings would become inline comments, mirroring the engine's filters. */
export function previewComments(findings: readonly PreviewFinding[], settings: CommentSettings) {
  const { minimumConfidence, severityThreshold } = effectiveThresholds(settings);
  const threshold = severities.indexOf(severityThreshold as Severity);
  const outcome = (f: PreviewFinding): CommentOutcome | undefined =>
    !settings.categories.includes(f.category) ? "category off" : f.confidence < minimumConfidence ? "low confidence" : severities.indexOf(f.severity) > threshold ? "below severity" : undefined;
  const eligible = findings.filter((f) => !outcome(f)).sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity) || b.confidence - a.confidence);
  const posted = new Set(eligible.slice(0, Math.max(0, settings.maxComments)).map((f) => f.id));
  return findings.map((f) => ({ ...f, outcome: (outcome(f) ?? (posted.has(f.id) ? "posted" : "over limit")) as CommentOutcome }));
}

export type TriggerSettings = { automatic: boolean; drafts: boolean; rereview: boolean; triggerLabels: readonly string[]; threadReplies: boolean };
export type PullRequestStep = { id: string; label: string; action: string; draft: boolean; label_?: string; prLabels: string[] };
export type TimelineEvent = { id: string; label: string; review: boolean; reason: string };
/** The example pull request events the triggers preview walks through. */
export function pullRequestSteps(settings: Pick<TriggerSettings, "triggerLabels">): PullRequestStep[] {
  const label = settings.triggerLabels.map((l) => l.trim()).find(Boolean);
  return [
    { id: "draft", label: "Draft opened", action: "opened", draft: true, prLabels: [] },
    { id: "ready", label: "Marked ready for review", action: "ready_for_review", draft: false, prLabels: [] },
    ...(label ? [{ id: "label", label: `Label “${label}” added`, action: "labeled", draft: false, label_: label, prLabels: [label] }] : []),
    { id: "push", label: "New commit pushed", action: "synchronize", draft: false, prLabels: label ? [label] : [] },
  ];
}
// Same rules as pullRequestTrigger (src/triggers.ts) for these events; tests keep them in parity.
export function pullRequestOutcome(step: PullRequestStep, s: TriggerSettings): { review: boolean; reason: string } {
  const labels = s.triggerLabels.map((l) => l.trim().toLowerCase()).filter(Boolean);
  const labelled = labels.length > 0 && step.prLabels.some((l) => labels.includes(l.toLowerCase()));
  if (step.draft && !s.drafts) return { review: false, reason: "Draft reviews are off" };
  if (step.action === "labeled") return step.label_ && labels.includes(step.label_.toLowerCase()) ? { review: true, reason: "Trigger label" } : { review: false, reason: "Not a trigger label" };
  if (["opened", "reopened", "ready_for_review"].includes(step.action)) return s.automatic ? { review: true, reason: "Automatic review" } : labelled ? { review: true, reason: "Trigger label" } : { review: false, reason: "Automatic reviews are off" };
  if (step.action === "synchronize") return !s.rereview ? { review: false, reason: "Re-review of new commits is off" } : s.automatic ? { review: true, reason: "Re-review of the new commit" } : labelled ? { review: true, reason: "Trigger label" } : { review: false, reason: "Automatic reviews are off" };
  return { review: false, reason: "No review" };
}
export function triggerTimeline(s: TriggerSettings): TimelineEvent[] {
  return [
    ...pullRequestSteps(s).map((step) => ({ id: step.id, label: step.label, ...pullRequestOutcome(step, s) })),
    { id: "reply", label: "Reply in an OpenReview thread", review: s.threadReplies, reason: s.threadReplies ? "Answered without a mention" : "Answered only with @openreview" },
    { id: "request", label: "Comment “@openreview review”", review: true, reason: "Explicit requests always run" },
  ];
}
