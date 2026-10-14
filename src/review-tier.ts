// Per-pull-request review tier: an explicit comment command, then an openreview:<tier> label, then the
// configured tier (settings, raised by touched .openreview/ folders). An admin cap always applies last.
export const tiers = ["fast", "standard", "deep"] as const;
export type Tier = (typeof tiers)[number];
export const reviewCommandPattern = /@openreview\s+review(?:\s+(again|security|fast|standard|deep))?\b/i;
export function reviewCommand(body: string): { category?: "security"; mode?: Tier } | null {
  const m = reviewCommandPattern.exec(body);
  if (!m) return null;
  const word = m[1]?.toLowerCase();
  return word === "security" ? { category: "security" } : word && (tiers as readonly string[]).includes(word) ? { mode: word as Tier } : {};
}
const labelPattern = /^openreview:(fast|standard|deep)$/i;
export const isTierLabel = (label: string) => labelPattern.test(label.trim());
// Several tier labels: the highest wins.
export function labelTier(labels: readonly string[]): Tier | undefined {
  const found = labels.map((l) => labelPattern.exec(l.trim())?.[1]?.toLowerCase() as Tier | undefined).filter((t): t is Tier => !!t);
  return found.sort((a, b) => tiers.indexOf(b) - tiers.indexOf(a))[0];
}
export function resolveTier(a: { configured: Tier; requested?: { mode: Tier; source: "comment" | "label" }; cap?: Tier }) {
  const wanted = a.requested?.mode ?? a.configured, source = a.requested?.source ?? "settings";
  const cap = a.cap ?? "deep", capped = tiers.indexOf(wanted) > tiers.indexOf(cap);
  return { mode: capped ? cap : wanted, source, capped, requested: wanted } as const;
}
