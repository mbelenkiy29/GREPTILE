import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  });
  return stdout;
}

/**
 * Shallow-checks out `ref` from `url` into `dir`. The URL (which may carry a
 * short-lived token) is passed per fetch and never written to .git/config.
 */
export async function checkout(url: string, dir: string, ref: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const isRepo = await stat(path.join(dir, ".git")).then(
    () => true,
    () => false,
  );
  if (!isRepo) await git(dir, ["init", "--quiet"]);
  await git(dir, ["fetch", "--quiet", "--depth=1", "--no-tags", url, ref]);
  await git(dir, ["checkout", "--quiet", "--force", "FETCH_HEAD"]);
  await git(dir, ["clean", "-fdxq"]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** Tracked files in the checkout (honours .gitignore). */
export async function listFiles(dir: string): Promise<string[]> {
  return (await git(dir, ["ls-files", "-z"])).split("\0").filter(Boolean);
}
