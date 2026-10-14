import type { SourceFile } from "./engine/types";

// Keep complete native documents and their provenance together. A skipped body
// must not leave a source citation in the context supplied to the review.
export function boundRequirementsContext(files: SourceFile[]) {
  const selected: SourceFile[] = [];
  let bytes = 0, omitted = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content, "utf8");
    if (bytes + size > 100000) { omitted++; continue; }
    bytes += size;
    selected.push(file);
  }
  return {
    files: selected,
    coverage: omitted ? ["Combined Linear and Atlassian plus Notion requirements context exceeded the 100KB limit; " + omitted + " fetched documents were omitted."] : [],
  };
}
