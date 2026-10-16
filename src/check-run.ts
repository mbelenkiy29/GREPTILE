import type {Finding} from "./engine/types";
import {priorityBadge} from "./priority";
import {reviewVerdict,verdictLabels,type Verdict} from "./verdict";

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled";
const order = ["critical", "high", "medium", "low"];
// Check-run conclusion: neutral unless a failure threshold is configured; then findings at or
// above that severity fail the check and anything else succeeds.
export function checkConclusion(findings: Pick<Finding, "severity">[], threshold: string | undefined): CheckConclusion {
  if (!threshold || threshold === "off" || !order.includes(threshold)) return "neutral";
  return findings.some((f) => order.indexOf(f.severity) <= order.indexOf(threshold)) ? "failure" : "success";
}

const plural = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");
// The finished check: what was reviewed, the verdict, and why it failed when a configured gate
// (a severity, or a minimum confidence score) was not met. A score gate never fails an incomplete
// review that recorded no score; the check stays neutral and says so.
export function checkOutcome(a: { findings: Pick<Finding, "severity" | "title" | "filePath" | "startLine">[]; score?: number; files: number; posted: number; failureSeverity?: string; minimumScore?: number; verdict?: Verdict }): { conclusion: CheckConclusion; title: string; summary: string } {
  const bySeverity = checkConclusion(a.findings, a.failureSeverity);
  const gate = a.minimumScore && a.minimumScore > 0 ? a.minimumScore : 0;
  const byScore: CheckConclusion = !gate || a.score === undefined ? "neutral" : a.score < gate ? "failure" : "success";
  const conclusion: CheckConclusion = bySeverity === "failure" || byScore === "failure" ? "failure" : bySeverity === "success" || byScore === "success" ? "success" : "neutral";
  const verdict = verdictLabels[a.verdict ?? reviewVerdict({ score: a.score, findings: a.findings })];
  const reviewed = `Reviewed ${plural(a.files, "file")} · ${a.findings.length ? plural(a.findings.length, "finding") : "no findings"}`;
  const title = byScore === "failure" ? `Confidence ${a.score}/5 is below the required ${gate}/5` : bySeverity === "failure" ? `${plural(a.findings.length, "verified finding")} at or above ${a.failureSeverity} severity` : reviewed;
  const lines = [
    `**${verdict}**${a.score === undefined ? "" : ` · Confidence score **${a.score}/5**`}`,
    "",
    `${reviewed}; ${plural(a.posted, "new inline comment")} posted.`,
    ...(a.findings.length ? ["", ...a.findings.slice(0, 10).map((f) => `- ${priorityBadge(f.severity)} ${f.title} (\`${f.filePath}:${f.startLine}\`)`), ...(a.findings.length > 10 ? [`- ${a.findings.length - 10} more on the review page.`] : [])] : ["", "OpenReview found no verified issues in this revision."]),
    ...(byScore === "failure" ? ["", `The review itself completed. This check fails because the workspace requires a confidence score of at least ${gate}/5 before merging.`] : []),
    ...(gate && a.score === undefined ? ["", `No confidence score was recorded, so the required ${gate}/5 was not checked.`] : []),
  ];
  return { conclusion, title, summary: lines.join("\n") };
}
// Reviews stopped because a newer commit arrived (or the pull request closed) end neutral, not failed.
export const supersededCheck = (message: string) => /Review cancelled|Review is obsolete/.test(message);
// Posted once on a pull request whose review the workspace's plan blocked. Plan details (limits,
// trial dates) stay on the billing page; anyone who can read the pull request sees this text.
export function billingNoticeBody(appUrl: string | undefined) {
  let link = "";
  try { const url = appUrl ? new URL("/dashboard/settings/billing", appUrl) : undefined; if (url?.protocol === "https:") link = ` in [Settings → Billing](${url.href})`; } catch {}
  return `OpenReview did not review this pull request because the workspace's plan does not cover more reviews right now. A workspace admin can check the plan${link}. Reviews start again automatically on the next push once the plan allows them, or comment \`@openreview review\`.`;
}
