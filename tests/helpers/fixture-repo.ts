import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway local git repository usable as a clone URL. */
export class FixtureRepo {
  readonly dir = mkdtempSync(path.join(tmpdir(), "tw-fixture-"));

  constructor(readonly branch = "main") {
    this.git("init", "--quiet", "-b", branch);
    this.git("config", "user.email", "fixture@example.com");
    this.git("config", "user.name", "Fixture");
    this.git("config", "uploadpack.allowAnySHA1InWant", "true");
  }

  git(...args: string[]) {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" }).trim();
  }

  /** Writes (string) or deletes (null) files, commits, and returns the new sha. */
  commit(changes: Record<string, string | null>, message = "change"): string {
    for (const [p, content] of Object.entries(changes)) {
      const abs = path.join(this.dir, p);
      if (content === null) rmSync(abs);
      else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    this.git("add", "-A");
    this.git("commit", "--quiet", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  get url() {
    return `file://${this.dir}`;
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function tempDir(prefix = "tw-cache-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
