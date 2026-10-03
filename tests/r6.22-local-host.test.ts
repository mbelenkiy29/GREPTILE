/**
 * The local git host (R6.22 demo / local mode): it passes the same GitClient conformance suite as GitHub, GitLab, and
 * Bitbucket (R3.6), answers from real git and the Postgres store, and cannot be created outside demo mode or in
 * production unless that is explicitly allowed.
 */
import { afterEach, describe, expect, test } from "vitest";
import { localModeEnv } from "@/lib/env";
import { GitHosts, hostFor, UnsupportedProviderError } from "@/lib/git/hosts";
import { LocalGitHost } from "@/lib/git/local/host";
import { LocalModeDisabledError, localModeBlocker, localModeEnabled, requireLocalMode } from "@/lib/git/local/guard";
import { LocalRepoError, parseFullName } from "@/lib/git/local/repo";
import { addLocalComment, addLocalReaction, getLocalPullRequest, openLocalPullRequest } from "@/lib/git/local/store";
import { blobUrl, commentUrl, prUrl, repoWeb } from "@/lib/git/web-url";
import { FakeGitHost } from "./helpers/fake-git";
import { FixtureRepo } from "./helpers/fixture-repo";
import { BASE_CONTENT, CONTENT, gitClientConformance, MID_CONTENT, PATH, README, type ConformanceSubject } from "./helpers/git-conformance";
import { localHostWorld } from "./helpers/local-host";

const fixtures: FixtureRepo[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

/** The conformance world on the local host: acme/shop with PR #7 (main ← feature, two commits), approved by maria. */
async function localSubject(): Promise<ConformanceSubject> {
  const world = await localHostWorld();
  const fixture = new FixtureRepo();
  fixtures.push(fixture);
  const base = fixture.commit({ [PATH]: BASE_CONTENT, "README.md": README }, "base");
  fixture.git("checkout", "--quiet", "-b", "feature");
  fixture.git("config", "user.name", "dev");
  const mid = fixture.commit({ [PATH]: MID_CONTENT }, "first");
  const head = fixture.commit({ [PATH]: CONTENT }, "second");
  await world.publish(fixture, "acme/shop", ["main", "feature"]);
  const { installation, repos } = await world.connect("acme");
  const repo = repos.find((r) => r.fullName === "acme/shop")!;
  const pr = await openLocalPullRequest(world.db, world.root, {
    orgId: "org_a",
    repoId: repo.id,
    fullName: "acme/shop",
    number: 7,
    title: "Add things",
    body: "Adds things.",
    author: "dev",
    baseRef: "main",
    headRef: "feature",
  });
  await addLocalComment(world.db, pr, { kind: "review", body: "", author: "maria", state: "APPROVED", commitSha: head });
  return {
    client: world.host.client(installation.externalId),
    shas: { base, mid, head },
    checks: false,
    react: (id) => addLocalReaction(world.db, pr, id, { content: "+1", user: "maria" }),
  };
}

describe("GitClient conformance: local demo host", () => {
  gitClientConformance("R6.22", "Local", localSubject, "file");
});

describe("local git host (R6.22)", () => {
  test("R6.22 a push to the head branch moves the pull request, and only connected repositories are reachable", async () => {
    const world = await localHostWorld();
    const fixture = new FixtureRepo();
    fixtures.push(fixture);
    fixture.commit({ "src/a.ts": "export const a = 1;\n" }, "base");
    fixture.git("checkout", "--quiet", "-b", "feature");
    const first = fixture.commit({ "src/a.ts": "export const a = 2;\n" }, "change");
    await world.publish(fixture, "acme/shop", ["main", "feature"]);
    const { installation, repos } = await world.connect("acme");
    expect(repos.map((r) => [r.fullName, r.defaultBranch])).toEqual([["acme/shop", "main"]]);
    const repo = repos[0]!;
    await openLocalPullRequest(world.db, world.root, { orgId: "org_a", repoId: repo.id, fullName: "acme/shop", title: "A", author: "dev", baseRef: "main", headRef: "feature" });
    const client = world.host.client(installation.externalId);
    expect((await client.getPullRequest("acme/shop", 1)).headSha).toBe(first);

    const second = fixture.commit({ "src/b.ts": "export const b = 1;\n" }, "more");
    await world.publish(fixture, "acme/shop", ["feature"]);
    expect((await client.getPullRequest("acme/shop", 1)).headSha).toBe(second);
    expect((await getLocalPullRequest(world.db, "org_a", repo.id, 1))!.headSha).toBe(second);
    expect((await client.listPullRequestFiles("acme/shop", 1)).map((f) => [f.path, f.status])).toEqual([
      ["src/a.ts", "modified"],
      ["src/b.ts", "added"],
    ]);
    // An inline comment outside the diff is refused, as a git host would.
    await expect(client.createReview("acme/shop", 1, { commitId: second, body: "", comments: [{ path: "README.md", line: 1, body: "x" }] })).rejects.toThrow(LocalRepoError);

    // Another org's installation id, or a repository that is not connected, reaches nothing.
    await expect(world.host.client(installation.externalId + 1).getPullRequest("acme/shop", 1)).rejects.toThrow(LocalRepoError);
    await expect(client.getFileContent("acme/other", "src/a.ts", "main")).rejects.toThrow(LocalRepoError);
    expect(() => parseFullName("../etc/passwd")).toThrow(LocalRepoError);
    expect(() => parseFullName("acme/..")).toThrow(LocalRepoError);
  });

  test("R6.22 local mode is refused without DEMO_MODE and in production unless explicitly allowed", async () => {
    const world = await localHostWorld();
    const off = { NODE_ENV: "development", DEMO_MODE: false, DEMO_MODE_ALLOW_PRODUCTION: false } as const;
    const prod = { NODE_ENV: "production", DEMO_MODE: true, DEMO_MODE_ALLOW_PRODUCTION: false } as const;
    expect(() => new LocalGitHost({ db: world.db, root: world.root, mode: off })).toThrow(LocalModeDisabledError);
    expect(() => new LocalGitHost({ db: world.db, root: world.root, mode: prod })).toThrow(/refused when NODE_ENV=production/);
    expect(localModeBlocker({ ...prod, DEMO_MODE_ALLOW_PRODUCTION: true })).toBeNull();

    // Parsed from the environment: off by default, refused in production.
    expect(localModeEnabled({})).toBe(false);
    expect(localModeEnabled({ DEMO_MODE: "true", NODE_ENV: "development" })).toBe(true);
    expect(localModeEnabled({ DEMO_MODE: "true", NODE_ENV: "production" })).toBe(false);
    expect(localModeEnabled({ DEMO_MODE: "true", NODE_ENV: "production", DEMO_MODE_ALLOW_PRODUCTION: "true" })).toBe(true);
    expect(() => requireLocalMode({ NODE_ENV: "production", DEMO_MODE: "true" })).toThrow(LocalModeDisabledError);
    expect(localModeEnv({}).LOCAL_GIT_ROOT).toBe("/tmp/openreview-local-git");

    // Without a registered local host, a local installation gets a clear unsupported-provider error.
    const registry = new GitHosts(new FakeGitHost());
    expect(() => hostFor(registry, "local")).toThrow(UnsupportedProviderError);
    expect(hostFor(new GitHosts(new FakeGitHost(), { local: world.host }), "local")).toBe(world.host);
  });

  test("R6.22 dashboard links for local repositories open the local pull request and file pages", () => {
    const web = repoWeb("local", null, "https://github.com");
    expect(prUrl(web, "acme/shop", 7)).toBe("/dashboard/local/pr?repo=acme%2Fshop&number=7");
    expect(commentUrl(web, "acme/shop", 7, 12)).toBe("/dashboard/local/pr?repo=acme%2Fshop&number=7#comment-12");
    expect(blobUrl(web, "acme/shop", "abc", "src/a.ts", 3)).toBe("/dashboard/local/browse?repo=acme%2Fshop&ref=abc&path=src%2Fa.ts#L3");
  });
});
