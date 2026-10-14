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
