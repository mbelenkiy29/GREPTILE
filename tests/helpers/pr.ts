import type { PullRequest, PullRequestFile } from "@/lib/git/types";
import type { FixtureRepo } from "./fixture-repo";
import type { FakeGitHost } from "./fake-git";

/** Registers a PR on the fake host whose files/patches come from a real `git diff base..head`. */
export function addPrFromFixture(
  host: FakeGitHost,
  fixture: FixtureRepo,
  repo: string,
  opts: { number: number; base: string; head: string; title?: string; body?: string; author?: string },
) {
  const names = fixture.git("diff", "--name-status", opts.base, opts.head).split("\n").filter(Boolean);
  const files: PullRequestFile[] = [];
  const head: Record<string, string> = {};
  for (const line of names) {
    const [code, path] = line.split("\t") as [string, string];
    const status = code === "A" ? "added" : code === "D" ? "removed" : "modified";
    const raw = fixture.git("diff", "-U3", opts.base, opts.head, "--", path);
    const patch = raw.slice(raw.indexOf("@@"));
    files.push({ path, status, patch });
    if (status !== "removed") head[path] = fixture.git("show", `${opts.head}:${path}`) + "\n";
  }
  const pr: PullRequest = {
    number: opts.number,
    title: opts.title ?? "Change",
    body: opts.body ?? "",
    author: opts.author ?? "dev",
    headSha: opts.head,
    baseSha: opts.base,
    baseRef: "main",
    headRef: "feature",
    state: "open",
    draft: false,
  };
  host.addPr(repo, { pr, files, head });
  return pr;
}
