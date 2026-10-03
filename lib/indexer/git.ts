import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Commits of history recorded per index run (R6.3). */
export const COMMIT_HISTORY = 50;

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });

async function git(cwd: string, args: string[], opts: { timeoutMs?: number } = {}) {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    env: gitEnv(),
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
  return stdout;
}

async function ensureRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  const isRepo = await stat(path.join(dir, ".git")).then(
    () => true,
    () => false,
  );
  if (!isRepo) await git(dir, ["init", "--quiet"]);
}

/**
 * Fetches `ref` (a branch name or a commit sha) from `url` into `dir` with enough history to record the last
 * `COMMIT_HISTORY` commits (one extra so the oldest recorded commit still has its parent to diff against), and
 * returns the fetched commit's sha. The URL (which may carry a short-lived token) is passed per fetch and never
 * written to .git/config.
 */
export async function fetchRef(url: string, dir: string, ref: string, opts: { depth?: number; timeoutMs?: number } = {}): Promise<string> {
  await ensureRepo(dir);
  await git(dir, ["fetch", "--quiet", `--depth=${opts.depth ?? COMMIT_HISTORY + 1}`, "--no-tags", "--", url, ref], opts);
  return (await git(dir, ["rev-parse", "FETCH_HEAD"])).trim();
}

/** A file's content at commit `sha`, or null when it does not exist there (or is larger than `maxBytes`). */
export async function readBlob(dir: string, sha: string, filePath: string, maxBytes = 2 * 1024 * 1024): Promise<Buffer | null> {
  const spec = `${sha}:${filePath}`;
  const size = await git(dir, ["cat-file", "-s", spec]).then(
    (s) => Number(s.trim()),
    () => null,
  );
  if (size === null || !Number.isFinite(size) || size > maxBytes) return null;
  const { stdout } = await exec("git", ["cat-file", "blob", spec], { cwd: dir, encoding: "buffer", maxBuffer: maxBytes + 1024, env: gitEnv() });
  return stdout;
}

/** The tree of commit `sha` as a tar stream (`git archive`): the files as committed, without `.git`. */
export function archiveTree(dir: string, sha: string): Readable {
  const child = spawn("git", ["archive", "--format=tar", sha], { cwd: dir, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    if (stderr.length < 2000) stderr += d.toString("utf8");
  });
  child.on("close", (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`git archive failed (exit ${code}): ${stderr.trim().slice(0, 500)}`));
  });
  child.on("error", (err) => child.stdout.destroy(err));
  return child.stdout;
}

/** Checks out a fetched commit as a clean working tree and returns its sha. */
export async function checkoutCommit(dir: string, sha: string): Promise<string> {
  await git(dir, ["checkout", "--quiet", "--force", sha]);
  await git(dir, ["clean", "-fdxq"]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** Fetches `ref` from `url` and checks it out (see `fetchRef`). */
export async function checkout(url: string, dir: string, ref: string): Promise<string> {
  return checkoutCommit(dir, await fetchRef(url, dir, ref));
}

/** Whether the commit `sha` is present in the local repository. */
export async function hasCommit(dir: string, sha: string): Promise<boolean> {
  return git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );
}

/** Whether `ancestor` is reachable from `descendant` in the fetched history (false when unknown). */
export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  return git(dir, ["merge-base", "--is-ancestor", ancestor, descendant]).then(
    () => true,
    () => false,
  );
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
