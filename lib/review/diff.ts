export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** Line number in the new file (absent for deletions). */
  newLine?: number;
  oldLine?: number;
}

export interface FileDiff {
  path: string;
  status: string;
  lines: DiffLine[];
  /** New-file lines that GitHub accepts inline comments on (added + context lines in hunks). */
  commentable: Set<number>;
  added: Set<number>;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(path: string, status: string, patch: string | undefined): FileDiff {
  const lines: DiffLine[] = [];
  const commentable = new Set<number>();
  const added = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  for (const raw of (patch ?? "").split("\n")) {
    const h = HUNK.exec(raw);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), newLine });
      commentable.add(newLine);
      added.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldLine });
      oldLine++;
    } else if (newLine > 0) {
      lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, newLine, oldLine });
      commentable.add(newLine);
      newLine++;
      oldLine++;
    }
  }
  return { path, status, lines, commentable, added };
}

/** Diff rendered with new-file line numbers so reviewers can cite exact lines. */
export function renderDiff(d: FileDiff): string {
  const body = d.lines
    .map((l) => {
      const n = l.newLine === undefined ? "" : String(l.newLine);
      const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      return `${n.padStart(5)} ${mark} ${l.text}`;
    })
    .join("\n");
  return `### ${d.path} (${d.status})\n${body || "(no textual diff)"}`;
}

/** Inclusive ranges of added lines, for mapping changes onto symbols. */
export function addedRanges(d: FileDiff): [number, number][] {
  const sorted = [...d.added].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

const DEFAULT_IGNORES = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$/,
  /\.min\.(js|css)$/,
  /(^|\/)(dist|build|vendor|node_modules|__snapshots__)\//,
  /\.(png|jpe?g|gif|svg|ico|pdf|zip|gz|woff2?|ttf|lock)$/,
];

export function isReviewablePath(path: string, extraIgnores: RegExp[] = []): boolean {
  return ![...DEFAULT_IGNORES, ...extraIgnores].some((r) => r.test(path));
}
