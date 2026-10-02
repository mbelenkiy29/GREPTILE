export interface Feature {
  id: string;
  phase: number;
  description: string;
}

export interface TestCase {
  title: string;
  status: "passed" | "failed" | "skipped";
}

export interface CheckResult {
  name: string;
  ok: boolean;
}

export type Verdict = { id: string; pass: true } | { id: string; pass: false; reason: string };

const PHASE_HEADING = /^##\s+Phase\s+(\d+)\b/;
const FEATURE_LINE = /^-\s+(R\d+\.\d+)\s+(.*)$/;

/** Extracts feature IDs from the parity spec, grouped by the `## Phase N` heading they sit under. */
export function parseSpec(markdown: string): Feature[] {
  const features: Feature[] = [];
  let phase: number | undefined;
  for (const line of markdown.split("\n")) {
    const heading = PHASE_HEADING.exec(line);
    if (heading) {
      phase = Number(heading[1]);
      continue;
    }
    if (line.startsWith("## ")) {
      phase = undefined;
      continue;
    }
    const feature = FEATURE_LINE.exec(line);
    if (feature && phase !== undefined) {
      features.push({ id: feature[1]!, phase, description: feature[2]!.trim() });
    }
  }
  return features;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if a test title is attributed to `id` (`R1.1` matches "R1.1 foo" but not "R1.10 foo"). */
export function titleMatchesId(title: string, id: string): boolean {
  return new RegExp(`^${escapeRegExp(id)}(?![\\d.])`).test(title.trim());
}

/**
 * A feature passes only when every global check passed and it has at least one
 * attributed test, all of which passed (skipped tests do not count as coverage).
 */
export function judge(feature: Feature, checks: CheckResult[], tests: TestCase[]): Verdict {
  const failedCheck = checks.find((c) => !c.ok);
  if (failedCheck) return { id: feature.id, pass: false, reason: `${failedCheck.name} failed` };

  const mine = tests.filter((t) => titleMatchesId(t.title, feature.id));
  const ran = mine.filter((t) => t.status !== "skipped");
  if (ran.length === 0) {
    return { id: feature.id, pass: false, reason: mine.length ? "all tests skipped" : "no tests found" };
  }
  const failed = ran.filter((t) => t.status === "failed");
  if (failed.length) {
    return { id: feature.id, pass: false, reason: `${failed.length}/${ran.length} tests failed: ${failed[0]!.title}` };
  }
  return { id: feature.id, pass: true };
}

export function formatVerdict(v: Verdict): string {
  return v.pass ? `PASS ${v.id}` : `FAIL ${v.id} ${v.reason}`;
}

export function summaryLine(phase: string, verdicts: Verdict[]): string {
  return `PARITY ${phase}: ${verdicts.filter((v) => v.pass).length}/${verdicts.length} PASS`;
}
