import type { ChangedFile } from "./types";
export function classifyChanges(diff: ChangedFile[]) {
  const subsystems = new Set<string>(),
    languages = new Set<string>(),
    risks = new Set<string>();
  for (const file of diff) {
    const parts = file.path.split("/");
    subsystems.add(parts.length > 1 ? parts.slice(0, 2).join("/") : "root");
    languages.add(file.path.split(".").pop() ?? "unknown");
    const content = file.path + "\n" + file.patch;
    if (
      /auth|session|permission|token|redirect|password|query|exec\(/i.test(
        content,
      )
    )
      risks.add("security");
    if (/schema|migration|transaction|delete|database|\.sql/i.test(content))
      risks.add("data");
    if (/export|interface|api|route/i.test(content)) risks.add("compatibility");
    if (/Promise|async|cache|loop|for\s*\(/.test(content))
      risks.add("concurrency/performance");
    if (/test|spec|mock/i.test(content)) risks.add("testing");
    if (/package\.json|requirements|Cargo\.toml|go\.mod|lock$/.test(file.path))
      risks.add("dependencies");
  }
  return {
    subsystems: [...subsystems],
    languages: [...languages],
    riskAreas: [...risks],
  };
}

// Risk ranking for oversized changes: higher scores are reviewed first when a PR
// exceeds the mode's file or context budget; generated, vendored and docs files sink.
export function riskScore(file: ChangedFile): number {
  const content = file.path + "\n" + file.patch;
  let score = 0;
  if (/auth|session|permission|token|redirect|password|secret|crypt|query|exec\(|eval\(/i.test(content)) score += 50;
  if (/schema|migration|transaction|delete|database|\.sql/i.test(content)) score += 40;
  if (/export|interface|api|route/i.test(content)) score += 20;
  if (/Promise|async|cache|mutex|lock\(|for\s*\(/.test(content)) score += 15;
  if (/(^|\/)(package\.json|requirements[^/]*\.txt|Cargo\.toml|go\.mod|Gemfile|pom\.xml)$/.test(file.path)) score += 10;
  if (/(^|\/)(vendor|node_modules|dist|build|generated|__generated__|_generated)\/|\.min\.(js|css)$|(^|\/)[^/]*lock(\.json|\.yaml|file)?$|\.lock$|\.snap$/i.test(file.path)) score -= 60;
  if (/\.(md|mdx|txt|rst|adoc)$/i.test(file.path)) score -= 30;
  if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/.test(file.path)) score -= 10;
  if (file.status === "removed") score -= 20;
  const changed = (file.patch.match(/^[+-](?![+-]{2})/gm) ?? []).length;
  return score + Math.min(20, Math.log2(1 + changed) * 2);
}
