// Priority labels for findings: text plus an emoji marker, never hosted images, so they render
// the same on self-hosted and air-gapped installs, in Slack, email and plain-text clients.
export const priorities = { critical: "P0", high: "P1", medium: "P2", low: "P3" } as const;
export type Priority = (typeof priorities)[keyof typeof priorities];
const marks: Record<Priority, string> = { P0: "🔴", P1: "🟠", P2: "🟡", P3: "🔵" };
export const priorityOf = (severity: string): Priority => priorities[severity as keyof typeof priorities] ?? "P3";
export const priorityBadge = (severity: string) => marks[priorityOf(severity)] + " " + priorityOf(severity);
// Tags are separate from priority; security findings carry one (the security agent reuses it).
export const findingTags = (f: { category?: string }) => (f.category === "security" ? ["security"] : []) as "security"[];
export const tagLabels = { security: "Security" } as const;
export const tagBadges = (f: { category?: string }) => findingTags(f).map((t) => "🔒 " + tagLabels[t]);
