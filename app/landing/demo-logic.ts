// Pure logic behind the landing page's interactive demos. It runs in the browser, so it stays free
// of server, Node-only and validation dependencies.
import { analytics, chat } from "./sample";

/** Severity order shared with the review engine (src/engine/types.ts); a test keeps them equal. */
export const severityOrder = ["critical", "high", "medium", "low"] as const;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Analytics for the last `days` days, for one repository or all of them ("all"). */
export function analyticsView(days: number, repository: string) {
  const repos = repository === "all" ? Object.values(analytics.repositories) : [analytics.repositories[repository]].filter(Boolean);
  const from = Math.max(0, analytics.days.length - days);
  const daily = (pick: (r: (typeof repos)[number], i: number) => number) => analytics.days.slice(from).map((_, i) => sum(repos.map((r) => pick(r, from + i))));
  const reviews = daily((r, i) => r.reviews[i]), findings = daily((r, i) => r.findings[i].length), addressed = daily((r, i) => r.addressed[i]), pulls = daily((r, i) => r.pulls[i]);
  const cost = sum(repos.map((r) => sum(r.reviews.slice(from)) * r.costPerReview));
  const flagged = repos.flatMap((r) => r.findings.slice(from).flat());
  return {
    days: analytics.days.slice(from),
    reviews, findings, addressed,
    metrics: [["Total PRs", String(sum(pulls))], ["Total Reviews", String(sum(reviews))], ["Verified findings", String(sum(findings))], ["Model cost", `$${cost.toFixed(2)}`]] as [string, string][],
    severity: severityOrder.map((s) => [s, flagged.filter((f) => f === s).length] as [string, number]),
  };
}

/** The sample answer that best matches a typed question, by keyword prefixes; undefined when none match. */
export function answerFor(question: string) {
  const words = question.toLowerCase().match(/[a-z]+/g) ?? [];
  let best: (typeof chat.answers)[number] | undefined, top = 0;
  for (const answer of chat.answers) {
    const score = answer.keywords.filter((k) => words.some((w) => w.startsWith(k))).length;
    if (score > top) [best, top] = [answer, score];
  }
  return best;
}

/** The first `count` words of `text` as plain text, for a typed-out reveal before the rendered answer. */
export function revealWords(text: string, count: number) {
  return text.split(/(?<=\s)/).slice(0, count).join("").replaceAll("`", "");
}
export const wordCount = (text: string) => text.split(/(?<=\s)/).length;

/** The review-trigger switches in the settings demo, and the key of one combination of them. */
export const triggerFlags = ["automatic", "rereview", "drafts", "threadReplies"] as const;
export const triggerKey = (on: Partial<Record<string, boolean>>) => triggerFlags.map((k) => (on[k] ? "1" : "0")).join("");
