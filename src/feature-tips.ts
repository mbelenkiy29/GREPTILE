// One optional "Tip" line in the summary footer when a review's data suggests a feature would help.
// At most one tip per review, chosen in this priority order; the cooldown lives in convex/featureTips.ts.
export const tipKeys = ["ticket", "strictness", "rules", "agentic"] as const;
export type TipKey = (typeof tipKeys)[number];
export type TicketKind = "linear" | "jira" | "either";
export type TipSignals = {
  references: string; // pull request title, body and branch (untrusted; only matched, never echoed)
  connected: { linear: boolean; atlassian: boolean };
  rules: number;
  recentFindings: number;
  dismissedFindings: number;
  strictness: number;
  engine: string;
  agenticAvailable: boolean;
};
export const tipCooldown = { anyTipMs: 3 * 86_400_000, sameTipMs: 30 * 86_400_000 } as const;

export function ticketReference(text: string, connected: TipSignals["connected"]): TicketKind | undefined {
  if (!connected.linear && /https:\/\/linear\.app\/[\w-]+\/issue\/[A-Z0-9][A-Z0-9_]{0,49}-[1-9]\d{0,9}\b/i.test(text)) return "linear";
  if (!connected.atlassian && /https:\/\/[\w-]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9_]{0,49}-[1-9]\d{0,9}\b/i.test(text)) return "jira";
  // A bare key like ENG-42 could be either tracker; suggest one only when neither is connected.
  if (!connected.linear && !connected.atlassian && /\b[A-Z][A-Z0-9_]{1,49}-[1-9]\d{0,9}\b/.test(text)) return "either";
  return undefined;
}
export function eligibleTips(s: TipSignals): { key: TipKey; ticket?: TicketKind }[] {
  const tips: { key: TipKey; ticket?: TicketKind }[] = [];
  const ticket = ticketReference(s.references, s.connected);
  if (ticket) tips.push({ key: "ticket", ticket });
  // Half or more of at least ten recent rated findings dismissed, and strictness not already at its highest.
  if (s.recentFindings >= 10 && s.dismissedFindings * 2 >= s.recentFindings && s.strictness < 3) tips.push({ key: "strictness" });
  if (s.rules === 0) tips.push({ key: "rules" });
  if (s.agenticAvailable && s.engine !== "agentic") tips.push({ key: "agentic" });
  return tips;
}
const ticketNames: Record<TicketKind, string> = { linear: "Linear", jira: "Jira", either: "Linear or Jira" };
export function tipText(key: TipKey, ticket?: TicketKind) {
  switch (key) {
    case "ticket": return `This pull request mentions a ${ticketNames[ticket ?? "either"]} issue. Connect ${ticketNames[ticket ?? "either"]} under Settings → Integrations so reviews can check the change against the issue's requirements.`;
    case "strictness": return "Many recent findings in this repository were dismissed. A higher strictness under Settings → Review reports fewer, higher-confidence issues.";
    case "rules": return "This repository has no custom review rules. Add your team's conventions under Rules, or in `.openreview.json`, and reviews will check them.";
    case "agentic": return "The agentic review engine follows callers and definitions across files with read-only tools before it reports. Try it under Settings → Review → Engine.";
  }
}
export const tipLine = (key: TipKey, ticket?: TicketKind) => "\n\n💡 **Tip:** " + tipText(key, ticket) + " Turn tips off with the Feature tips summary section.";
