/**
 * Git plumbing for the local git host (R6.22): bare repositories under LOCAL_GIT_ROOT, laid out `<owner>/<name>.git`.
 * Every read a git host API would answer (pull request files, file contents, trees, comparisons, commits) is answered
 * here with git itself (`git diff`, `git show`, `git ls-tree`, `git log`).
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, PullRequestCommit, PullRequestFile } from "@/lib/git/types";
import { splitUnifiedDiff } from "@/lib/scm/diff";

const exec = promisify(execFile);

/** Owner and repository name segments: what GitHub allows, minus anything that could escape the root. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export class LocalRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRepoError";
  }
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });

async function run(cwd: string, args: string[], opts: { maxBytes?: number } = {}): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: opts.maxBytes ?? 256 * 1024 * 1024, env: gitEnv() });
  return stdout;
}

/** Splits and validates `owner/name`. */
export function parseFullName(fullName: string): { owner: string; name: string } {
  const [owner, name, ...rest] = fullName.split("/");
  if (!owner || !name || rest.length || !SEGMENT.test(owner) || !SEGMENT.test(name) || name.endsWith(".git") || owner.includes("..") || name.includes("..")) {
    throw new LocalRepoError(`invalid local repository name "${fullName}" (expected owner/name)`);
  }
  return { owner, name };
}

/** Absolute path of the bare repository for `owner/name`. */
export function repoDir(root: string, fullName: string): string {
  const { owner, name } = parseFullName(fullName);
  return path.join(path.resolve(root), owner, `${name}.git`);
}

/** `file://` clone URL of a bare repository. */
export function fileUrl(dir: string): string {
  return `file://${dir}`;
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** Whether `owner/name` exists under `root`. */
export async function repoExists(root: string, fullName: string): Promise<boolean> {
  return isDir(repoDir(root, fullName));
}

/**
 * Creates the bare repository for `owner/name` (no-op when it exists) and returns its path. Fetching any reachable
 * commit by sha is allowed, as the indexer fetches pull request heads by sha.
 */
export async function initBareRepo(root: string, fullName: string, defaultBranch: string): Promise<string> {
  const dir = repoDir(root, fullName);
  if (!(await isDir(dir))) {
    await mkdir(dir, { recursive: true });
    await run(dir, ["init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`]);
  }
  await run(dir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await run(dir, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  return dir;
}

/** Repository names (`name`, without `.git`) of `owner` under `root`. */
export async function listOwnerRepos(root: string, owner: string): Promise<string[]> {
  if (!SEGMENT.test(owner)) return [];
  const dir = path.join(path.resolve(root), owner);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && e.name.endsWith(".git"))
    .map((e) => e.name.slice(0, -4))
    .filter((n) => SEGMENT.test(n))
    .sort();
}

/** The bare repository's default branch (what HEAD points at). */
export async function defaultBranchOf(dir: string): Promise<string> {
  const ref = (await run(dir, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "refs/heads/main")).trim();
  return ref.replace(/^refs\/heads\//, "");
}

/** The commit a branch name or sha names, or null when it does not exist. */
export async function resolveCommit(dir: string, ref: string): Promise<string | null> {
  if (!ref || ref.startsWith("-")) return null;
  const out = await run(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).catch(() => "");
  return out.trim() || null;
}

/** The best common ancestor of two commits (the base a pull request's diff starts from). */
export async function mergeBase(dir: string, a: string, b: string): Promise<string | null> {
  const out = await run(dir, ["merge-base", a, b]).catch(() => "");
  return out.trim() || null;
}

const STATUS: Record<string, PullRequestFile["status"]> = { A: "added", M: "modified", D: "removed", R: "renamed", C: "copied", T: "changed" };

/** Files changed from `base` to `head` (`git diff --name-status -M`). */
export async function changedFiles(dir: string, base: string, head: string): Promise<ChangedFile[]> {
  const out = await run(dir, ["-c", "core.quotePath=false", "diff", "--name-status", "-M", "-z", "--no-ext-diff", base, head, "--"]);
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const status = STATUS[code[0]!] ?? "modified";
    if (status === "renamed" || status === "copied") {
      const previousPath = parts[i++]!;
      const p = parts[i++]!;
      files.push({ path: p, previousPath, status });
    } else {
      files.push({ path: parts[i++]!, status });
    }
  }
  return files;
}

/** Changed files with their unified diff hunks, the way a git host reports a pull request's files. */
export async function diffFiles(dir: string, base: string, head: string): Promise<PullRequestFile[]> {
  const files = await changedFiles(dir, base, head);
  const raw = await run(dir, ["-c", "core.quotePath=false", "diff", "-M", "--no-color", "--no-ext-diff", "-U3", base, head, "--"]);
  const patches = splitUnifiedDiff(raw);
  return files.map((f) => {
    const hit = patches.find((p) => (f.status === "removed" ? p.oldPath === f.path : p.newPath === f.path));
    return { ...f, ...(hit?.patch ? { patch: hit.patch } : {}) };
  });
}

/** A file's content at `ref` (branch or sha), or null when it does not exist there. */
export async function showFile(dir: string, ref: string, filePath: string): Promise<string | null> {
  if (!ref || ref.startsWith("-") || filePath.startsWith("-")) return null;
  const spec = `${ref}:${filePath}`;
  const type = await run(dir, ["cat-file", "-t", spec]).catch(() => "");
  if (type.trim() !== "blob") return null;
  return run(dir, ["cat-file", "blob", spec], { maxBytes: 64 * 1024 * 1024 });
}

/** Every file path at `ref`. */
export async function treePaths(dir: string, ref: string): Promise<string[]> {
  if (!ref || ref.startsWith("-")) return [];
  const out = await run(dir, ["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "-z", ref]).catch(() => "");
  return out.split("\0").filter(Boolean);
}

const RS = "\x1e";
const US = "\x1f";

/** Commits reachable from `head` but not `base`, oldest first. */
export async function commitsBetween(dir: string, base: string, head: string): Promise<PullRequestCommit[]> {
  const out = await run(dir, ["log", "--reverse", `--format=${RS}%H${US}%an${US}%cI${US}%B`, `${base}..${head}`]);
  return out
    .split(RS)
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, author, date, message] = r.split(US);
      return { sha: sha!.trim(), author: author ?? "", committedAt: date || null, message: (message ?? "").trim() };
    });
}

/** `git show --stat --patch` of one commit (for the local commit page). */
export async function showCommit(dir: string, sha: string): Promise<string> {
  if (!sha || sha.startsWith("-")) throw new LocalRepoError("invalid commit");
  return run(dir, ["show", "--no-color", "--no-ext-diff", "--stat", "--patch", "--format=commit %H%nAuthor: %an%nDate:   %cI%n%n%w(0,4,4)%B", sha], { maxBytes: 16 * 1024 * 1024 });
}
