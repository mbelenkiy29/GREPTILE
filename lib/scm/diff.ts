/** One file of a multi-file git diff: its paths (null for /dev/null) and its hunks (`@@ …` onward). */
export interface SplitFileDiff {
  oldPath: string | null;
  newPath: string | null;
  /** Hunk text without the `diff --git` / `---` / `+++` headers; empty for binary or mode-only changes. */
  patch: string;
}

function unquote(path: string): string {
  // git quotes paths with unusual characters: "a/dir/na\"me" → a/dir/na"me (only the common escapes).
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
}

function stripPrefix(path: string): string | null {
  const p = unquote(path.trim().replace(/\t.*$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/**
 * Splits a raw `git diff` (as Bitbucket's diff endpoints return it) into per-file hunks, in the same shape as a
 * GitHub/GitLab file `patch`. Paths come from the `---`/`+++` lines, or from `rename from`/`rename to` and the
 * `diff --git` line when a file has no hunks.
 */
export function splitUnifiedDiff(text: string): SplitFileDiff[] {
  const out: SplitFileDiff[] = [];
  let current: (SplitFileDiff & { hunks: string[]; inHunks: boolean }) | null = null;
  const flush = () => {
    if (current) out.push({ oldPath: current.oldPath, newPath: current.newPath, patch: current.hunks.join("\n").replace(/\n+$/, "") });
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      current = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, patch: "", hunks: [], inHunks: false };
      continue;
    }
    if (!current) continue;
    if (!current.inHunks) {
      if (line.startsWith("--- ")) current.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ")) current.newPath = stripPrefix(line.slice(4));
      else if (line.startsWith("rename from ")) current.oldPath = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) current.newPath = unquote(line.slice(10));
      else if (line.startsWith("new file mode")) current.oldPath = null;
      else if (line.startsWith("deleted file mode")) current.newPath = null;
      else if (line.startsWith("@@")) {
        current.inHunks = true;
        current.hunks.push(line);
      }
      continue;
    }
    current.hunks.push(line);
  }
  flush();
  return out;
}
