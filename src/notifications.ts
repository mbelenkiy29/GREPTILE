import { escapeSlack, slackLink } from "./slack";
import { priorityBadge, priorityOf, tagBadges, tagLabels, findingTags } from "./priority";

// Notification content for completed reviews. Channels (Slack, email) and recipients are chosen
// in convex/notifications.ts; delivery is idempotent per event, review and target.
export const notificationEvents = ["review.completed", "finding.high"] as const;
export type NotificationEvent = (typeof notificationEvents)[number];
export type ReviewNotice = { repository: string; prNumber: number; prTitle?: string; prUrl?: string; reviewUrl?: string; headSha: string; findings: { title: string; severity: string; category?: string; filePath: string; startLine: number }[] };
export const highFindings = (n: ReviewNotice) => n.findings.filter((f) => f.severity === "critical" || f.severity === "high");
export const appliesTo = (event: NotificationEvent, n: ReviewNotice) => event === "review.completed" || highFindings(n).length > 0;
const headline = (event: NotificationEvent, n: ReviewNotice) => event === "finding.high" ? `${highFindings(n).length} high-severity finding${highFindings(n).length === 1 ? "" : "s"} in ${n.repository}#${n.prNumber}` : `OpenReview finished reviewing ${n.repository}#${n.prNumber}: ${n.findings.length ? `${n.findings.length} finding${n.findings.length === 1 ? "" : "s"}` : "no findings"}`;
const listed = (event: NotificationEvent, n: ReviewNotice) => (event === "finding.high" ? highFindings(n) : n.findings).slice(0, 5);

export function slackReviewText(event: NotificationEvent, n: ReviewNotice) {
  const lines = [`*${escapeSlack(headline(event, n))}*`];
  if (n.prTitle) lines.push(n.prUrl ? slackLink(n.prUrl, n.prTitle.slice(0, 200)) : escapeSlack(n.prTitle.slice(0, 200)));
  for (const f of listed(event, n)) lines.push(`• ${priorityBadge(f.severity)}${tagBadges(f).map((t) => " · " + t).join("")} · ${escapeSlack(f.title.slice(0, 200))} — \`${escapeSlack(f.filePath)}:${f.startLine}\``);
  const more = (event === "finding.high" ? highFindings(n) : n.findings).length - listed(event, n).length;
  if (more > 0) lines.push(`…and ${more} more`);
  if (n.reviewUrl) lines.push(slackLink(n.reviewUrl, "View the review"));
  return lines.join("\n");
}
export function emailReview(event: NotificationEvent, n: ReviewNotice) {
  const lines = [headline(event, n), ""];
  if (n.prTitle) lines.push(`Pull request: ${n.prTitle.replace(/[\r\n]+/g, " ").slice(0, 200)}${n.prUrl ? ` (${n.prUrl})` : ""}`, "");
  for (const f of listed(event, n)) lines.push(`- [${[priorityOf(f.severity) + " " + f.severity, ...findingTags(f).map((t) => tagLabels[t])].join(", ")}] ${f.title.replace(/[\r\n]+/g, " ").slice(0, 200)} (${f.filePath}:${f.startLine})`);
  if (n.reviewUrl) lines.push("", `View the review: ${n.reviewUrl}`);
  lines.push("", "Change these emails in OpenReview → Settings → Notifications.");
  return { subject: headline(event, n).slice(0, 200), text: lines.join("\n") };
}
