/** The git operations `openreview review` and `status` need: the repository, branches, the base, and the diff. */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TreeEntry } from "@/lib/indexer/git";
import type { LocalReviewFile } from "@/lib/review/local";
import { CliError } from "./errors";

const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_UNTRACKED_PATCH_BYTES = 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function git(cwd: string, args: string[], opts: { input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    if (opts.input === undefined) {
      execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, env, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args[0]} failed: ${(stderr || err.message).trim()}`, stderr));
        else resolve(stdout);
      });
      return;
    }
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], { cwd, env });
    let out = "";
    let errText = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (errText += d));
    child.on("error", (err) => reject(new GitError(`git ${args[0]} failed: ${err.message}`, errText)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new GitError(`git ${args[0]} failed: ${errText.trim()}`, errText))));
    child.stdin.end(opts.input);
  });
}

const ok = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );

/** The repository's top-level directory; a helpful error outside a repository or without git. */
export async function repoRoot(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || /spawn git ENOENT/.test(String(err))) throw new CliError("git is not installed or not on your PATH.");
    throw new CliError("This is not a git repository.", "Run openreview inside your project's git checkout.");
  }
}

/** The checked-out branch, or null on a detached HEAD. */
export async function currentBranch(root: string): Promise<string | null> {
  try {
    return (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

export async function headSha(root: string): Promise<string> {
  try {
    return (await git(root, ["rev-parse", "HEAD"])).trim();
  } catch {
    throw new CliError("This repository has no commits yet.", "Commit your work first; openreview reviews changes against a base commit.");
  }
}

/** `owner/name` (GitLab: `group/subgroup/name`) from a remote URL (https, ssh, or scp-like), or null. */
export function parseRemote(url: string): string | null {
  const trimmed = url.trim();
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(trimmed) ?? /^(?:[^@/]+@)?[^:/]+:(?!\/)(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (!m) return null;
  const parts = m[1]!.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.join("/");
}

/** The repository's `owner/name` from the `origin` remote (else the first remote), or null. */
export async function remoteRepo(root: string): Promise<string | null> {
  const remotes = (await git(root, ["remote"]).catch(() => "")).split("\n").filter(Boolean);
  const name = remotes.includes("origin") ? "origin" : remotes[0];
  if (!name) return null;
  const url = await git(root, ["remote", "get-url", name]).catch(() => "");
  return parseRemote(url);
}

/** The ref to compare against when no `--base` is given: the remote's default branch, else main/master. */
export async function defaultBaseRef(root: string): Promise<string> {
  const originHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (originHead.trim()) return originHead.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (await ok(git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))) return ref;
  }
  throw new CliError("Couldn't find the base branch to compare against (no origin/HEAD, main, or master).", "Pass it explicitly, e.g. `openreview review --base develop`.");
}

export interface BaseResolution {
  ref: string;
  /** The merge base of HEAD and `ref`: what the change is compared against. */
  sha: string;
}

export async function resolveBase(root: string, base: string | undefined): Promise<BaseResolution> {
  const ref = base ?? (await defaultBaseRef(root));
  if (!(await ok(git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])))) {
    throw new CliError(`The base "${ref}" is not a branch, tag, or commit in this repository.`, "Fetch it first (`git fetch origin`) or pass another --base.");
  }
  try {
    const sha = (await git(root, ["merge-base", "HEAD", ref])).trim();
    if (!sha) throw new Error("no merge base");
    return { ref, sha };
  } catch {
    throw new CliError(`HEAD and ${ref} have no common history.`, "Pass the branch this work started from with --base.");
  }
}

const STATUS: Record<string, LocalReviewFile["status"]> = { A: "added", M: "modified", D: "removed", R: "renamed", C: "copied", T: "changed" };

/** Unified diff hunks of one file (from the first `@@`), or undefined for binary files. */
function hunksOf(diff: string): string | undefined {
  if (/^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)) return undefined;
  const at = diff.search(/^@@ /m);
  if (at < 0) return "";
  return diff.slice(at).replace(/\n$/, "");
}

export interface ChangeSet {
  files: LocalReviewFile[];
  /** Whether the change includes uncommitted work (head contents come from the working tree). */
  worktree: boolean;
}

/**
 * The change between `baseSha` and HEAD — or the working tree (staged, unstaged, and untracked files) with
 * `includeUncommitted` — with each file's unified diff (3 lines of context, renames detected).
 */
export async function collectChanges(root: string, baseSha: string, includeUncommitted: boolean): Promise<ChangeSet> {
  const range = includeUncommitted ? [baseSha] : [baseSha, "HEAD"];
  const raw = await git(root, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", ...range]);
  const tokens = raw.split("\0").filter((t) => t !== "");
  const files: LocalReviewFile[] = [];
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++]!;
    const kind = code[0]!;
    if (kind === "R" || kind === "C") {
      const previousPath = tokens[i++]!;
      const p = tokens[i++]!;
      const diff = await git(root, ["diff", "-U3", "-M", "--no-color", "--no-ext-diff", ...range, "--", previousPath, p]);
      files.push({ path: p, previousPath, status: STATUS[kind]!, ...patchField(hunksOf(diff)) });
    } else {
      const p = tokens[i++]!;
      const diff = await git(root, ["diff", "-U3", "--no-color", "--no-ext-diff", ...range, "--", p]);
      files.push({ path: p, status: STATUS[kind] ?? "modified", ...patchField(hunksOf(diff)) });
    }
  }
  if (includeUncommitted) {
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const p of untracked) files.push({ path: p, status: "added", ...patchField(hunksOf(await untrackedPatch(root, p))) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, worktree: includeUncommitted };
}

function patchField(patch: string | undefined): { patch?: string } {
  return patch === undefined ? {} : { patch };
}

/** The diff of an untracked file (everything added), as `git diff` would print it. */
async function untrackedPatch(root: string, p: string): Promise<string> {
  const st = await lstat(path.join(root, p)).catch(() => null);
  if (!st?.isFile()) return "";
  // Too large to send as a diff: treat like a binary file (reviewed by name only).
  if (st.size > MAX_UNTRACKED_PATCH_BYTES) return "Binary files /dev/null and b differ";
  const buf = await readFile(path.join(root, p)).catch(() => null);
  if (!buf) return "";
  if (buf.subarray(0, 8192).includes(0)) return "Binary files /dev/null and b differ";
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) lines.pop();
  if (!lines.length) return "";
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ...(endsWithNewline ? [] : ["\\ No newline at end of file"])].join("\n");
}

/** A file's content at a commit, or null when it does not exist there (or is not text). */
export async function showFile(root: string, ref: string, p: string): Promise<string | null> {
  try {
    return await git(root, ["show", `${ref}:${p}`]);
  } catch {
    return null;
  }
}

/** A file's content in the working tree, or null when it is missing. */
export async function worktreeFile(root: string, p: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, p), "utf8");
  } catch {
    return null;
  }
}

/**
 * The working tree's files (tracked and untracked, honouring .gitignore) with content hashes — git blob ids, so an
 * unchanged file keeps its hash between runs — for the local index.
 */
export async function worktreeEntries(root: string): Promise<TreeEntry[]> {
  const paths = [...new Set((await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))];
  const present: { path: string; size: number }[] = [];
  const entries: TreeEntry[] = [];
  for (const p of paths) {
    const st = await lstat(path.join(root, p)).catch(() => null);
    if (!st) continue; // deleted but still in the index
    if (!st.isFile()) {
      entries.push({ path: p, blob: "", sizeBytes: 0, regular: false });
      continue;
    }
    present.push({ path: p, size: st.size });
  }
  if (present.length) {
    const ids = (await git(root, ["hash-object", "--no-filters", "--stdin-paths"], { input: present.map((f) => f.path).join("\n") + "\n" })).split("\n").filter(Boolean);
    present.forEach((f, i) => entries.push({ path: f.path, blob: ids[i] ?? createHash("sha1").update(f.path).digest("hex"), sizeBytes: f.size, regular: true }));
  }
  return entries;
}

/** A blob's raw bytes (`git cat-file blob`). */
export function readBlob(root: string, blob: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["cat-file", "blob", blob], { cwd: root, maxBuffer: MAX_BUFFER, encoding: "buffer" }, (err, stdout) => {
      if (err) reject(new GitError(`git cat-file failed for ${blob}`, ""));
      else resolve(stdout);
    });
  });
}

/** Adds `pattern` to `.git/info/exclude` once, so local artifacts never show up as untracked files. */
export async function ensureExcluded(root: string, pattern: string): Promise<void> {
  const rel = (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split("\n").some((l) => l.trim() === pattern)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}# openreview CLI local index\n${pattern}\n`);
}
