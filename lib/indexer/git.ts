import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Commits of history recorded per index run (R6.3). */
export const COMMIT_HISTORY = 50;

async function git(cwd: string, args: string[]) {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  });
  return stdout;
}

/**
 * Checks out `ref` from `url` into `dir` with enough history to record the last `COMMIT_HISTORY` commits (one extra
 * so the oldest recorded commit still has its parent to diff against). The URL (which may carry a short-lived
 * token) is passed per fetch and never written to .git/config.
 */
export async function checkout(url: string, dir: string, ref: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const isRepo = await stat(path.join(dir, ".git")).then(
    () => true,
    () => false,
  );
  if (!isRepo) await git(dir, ["init", "--quiet"]);
  await git(dir, ["fetch", "--quiet", `--depth=${COMMIT_HISTORY + 1}`, "--no-tags", url, ref]);
  await git(dir, ["checkout", "--quiet", "--force", "FETCH_HEAD"]);
  await git(dir, ["clean", "-fdxq"]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** Tracked files in the checkout (honours .gitignore). */
export async function listFiles(dir: string): Promise<string[]> {
  return (await git(dir, ["ls-files", "-z"])).split("\0").filter(Boolean);
}

export interface TreeEntry {
  path: string;
  /** Git blob id: a content hash that needs no read of the file. */
  blob: string;
  sizeBytes: number;
  /** Regular file (not a symlink or submodule). */
  regular: boolean;
}

/**
 * Tracked files at HEAD with their blob ids and sizes (`git ls-tree -r -l`), equivalent to `git ls-files` for a
 * clean checkout but without stat-ing or reading any file.
 */
export async function listTree(dir: string): Promise<TreeEntry[]> {
  const out = await git(dir, ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"]);
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!m) continue;
    const [, mode, type, blob, size, p] = m;
    entries.push({
      path: p!,
      blob: blob!,
      sizeBytes: size === "-" ? 0 : Number(size),
      regular: type === "blob" && (mode === "100644" || mode === "100755"),
    });
  }
  return entries;
}

export interface CommitInfo {
  sha: string;
  parentSha: string | null;
  author: string;
  committedAt: Date;
  message: string;
  changedPaths: string[];
}

const RS = "\x1e";
const US = "\x1f";

/**
 * The last `limit` commits of HEAD along first parents (the indexed branch's own history), each with the paths it
 * changed relative to its first parent.
 */
export async function readCommits(dir: string, limit = COMMIT_HISTORY): Promise<CommitInfo[]> {
  const out = await git(dir, [
    "-c",
    "core.quotePath=false",
    "log",
    `-n${limit}`,
    "--first-parent",
    "-m",
    "--name-only",
    `--format=${RS}%H${US}%P${US}%an${US}%cI${US}%B${US}`,
    "HEAD",
  ]);
  const commits: CommitInfo[] = [];
  for (const record of out.split(RS)) {
    if (!record.trim()) continue;
    const [sha, parents, author, date, body, names] = record.split(US);
    if (!sha || !date) continue;
    commits.push({
      sha,
      parentSha: parents?.split(" ").find(Boolean) ?? null,
      author: author ?? "",
      committedAt: new Date(date),
      message: (body ?? "").trim(),
      changedPaths: [...new Set((names ?? "").split("\n").map((l) => l.trim()).filter(Boolean))],
    });
  }
  return commits;
}
