import picomatch from "picomatch";
import { changedLines } from "./engine/patch-lines";
import type { ChangedFile } from "./engine/types";

// Review triggers for pull request webhooks. Automatic reviews follow `automatic`/`rereview`;
// trigger labels start a review on `labeled` (and keep re-reviewing labelled PRs); excluded
// author globs and branch/draft filters apply to both. Explicit "@openreview review" requests are
// handled separately and bypass these filters.
export type TriggerSettings = {
  automatic: boolean; drafts: boolean; rereview: boolean;
  targetBranches: string[]; ignoredBranches: string[];
  triggerLabels?: string[]; excludedAuthors?: string[];
};
export type PullRequestEvent = {
  action: string; label?: string;
  pr: { draft: boolean; base: { ref: string }; head: { ref: string }; user?: { login: string }; labels?: { name: string }[] };
};
export function pullRequestTrigger(event: PullRequestEvent, settings: TriggerSettings): { review: true; trigger: "automatic" | "label" } | { review: false; reason: string } {
  const { pr, action } = event;
  const labels = (settings.triggerLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const labelled = labels.length > 0 && (pr.labels ?? []).some((l) => labels.includes(l.name.toLowerCase()));
  const author = pr.user?.login;
  if (author && (settings.excludedAuthors ?? []).length && picomatch(settings.excludedAuthors!, { nocase: true })(author)) return { review: false, reason: `Author ${author} is excluded` };
  if (settings.targetBranches.length && !picomatch(settings.targetBranches)(pr.base.ref)) return { review: false, reason: "Target branch is not configured for review" };
  if (settings.ignoredBranches.length && picomatch(settings.ignoredBranches)(pr.head.ref)) return { review: false, reason: "Source branch is ignored" };
  if (pr.draft && !settings.drafts) return { review: false, reason: "Draft reviews are disabled" };
  if (action === "labeled") return event.label && labels.includes(event.label.toLowerCase()) ? { review: true, trigger: "label" } : { review: false, reason: "Label is not a review trigger" };
  if (["opened", "reopened", "ready_for_review"].includes(action)) return settings.automatic ? { review: true, trigger: "automatic" } : labelled ? { review: true, trigger: "label" } : { review: false, reason: "Automatic reviews are off" };
  if (action === "synchronize") return !settings.rereview ? { review: false, reason: "Re-review of new revisions is off" } : settings.automatic ? { review: true, trigger: "automatic" } : labelled ? { review: true, trigger: "label" } : { review: false, reason: "Automatic reviews are off" };
  return { review: false, reason: "Event does not trigger reviews" };
}

// Size limits for automatic/label-triggered reviews (0 disables a limit).
export function sizeLimitIssue(diff: ChangedFile[], settings: { maxFiles?: number; maxChangedLines?: number }): string | undefined {
  if (settings.maxFiles && diff.length > settings.maxFiles) return `Skipped: ${diff.length} changed files exceed the configured limit of ${settings.maxFiles}. Comment "@openreview review" to review anyway.`;
  if (settings.maxChangedLines) {
    let lines = 0;
    for (const file of diff) lines += changedLines(file.patch).size + (file.patch.match(/^-(?!--)/gm)?.length ?? 0);
    if (lines > settings.maxChangedLines) return `Skipped: ${lines} changed lines exceed the configured limit of ${settings.maxChangedLines}. Comment "@openreview review" to review anyway.`;
  }
  return undefined;
}

// Strictness presets live with the settings defaults (browser-safe); re-exported for existing callers.
export { strictnessPresets, effectiveThresholds } from "./review-settings";
