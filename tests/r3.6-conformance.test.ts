/**
 * GitClient conformance (R3.6): the same provider-neutral expectations for every method, run against GitHub (the
 * in-memory host), GitLab, and Bitbucket Cloud (their REST APIs faked behind an injected fetch). The suite itself is
 * in `helpers/git-conformance.ts` (the local demo host runs it too, R6.22).
 */
import { beforeAll, describe, vi } from "vitest";
import { BitbucketHost } from "@/lib/bitbucket/client";
import { GitLabHost } from "@/lib/gitlab/client";
import { FakeBitbucket, FakeGitLab, type ScmWorld } from "./helpers/fake-scm";
import { FakeGitHost } from "./helpers/fake-git";
import { CONTENT, gitClientConformance, PATCH, PATH, type ConformanceSubject } from "./helpers/git-conformance";

beforeAll(() => {
  vi.stubEnv("APP_SECRET", "conformance-secret-0123456789");
});

const BASE = "a1".repeat(20);
const MID = "b2".repeat(20);
const HEAD = "c3".repeat(20);
const shas = { base: BASE, mid: MID, head: HEAD };

const world: ScmWorld = {
  repo: "acme/shop",
  defaultBranch: "main",
  pr: { number: 7, title: "Add things", body: "Adds things.", author: "dev", base: BASE, head: HEAD, sourceBranch: "feature", targetBranch: "main" },
  files: [{ path: PATH, status: "modified", patch: PATCH }],
  contentAt: (ref, path) => (ref === HEAD && path === PATH ? CONTENT : null),
  treeAt: (ref) => (ref === HEAD ? [PATH, "README.md"] : []),
  compareAt: () => [{ path: PATH, status: "modified" }],
  commits: [
    { sha: MID, message: "first", author: "dev", date: "2026-10-01T09:00:00Z" },
    { sha: HEAD, message: "second", author: "dev", date: "2026-10-01T10:00:00Z" },
  ],
  approvals: ["maria"],
  checks: [{ name: "ci", ok: true }],
};

function github(): ConformanceSubject {
  const host = new FakeGitHost();
  host.addPr("acme/shop", {
    pr: { number: 7, title: "Add things", body: "Adds things.", author: "dev", headSha: HEAD, baseSha: BASE, baseRef: "main", headRef: "feature", state: "open", draft: false },
    files: [{ path: PATH, status: "modified", patch: PATCH }],
    head: { [PATH]: CONTENT },
  });
  host.treeAt = (_repo, ref) => world.treeAt(ref);
  host.compareAt = () => [{ path: PATH, status: "modified" }];
  host.commits.set("acme/shop#7", world.commits.map((c) => ({ sha: c.sha, message: c.message, author: c.author, committedAt: c.date })));
  host.humanReviews.set("acme/shop#7", [{ id: 1, author: "maria", state: "APPROVED", body: "", commitId: HEAD, submittedAt: null }]);
  host.checkRuns.set(`acme/shop@${HEAD}`, [{ name: "ci", status: "completed", conclusion: "success" }]);
  host.cloneUrls.set("acme/shop", "https://x-access-token:ghs_fake@github.example/acme/shop.git");
  return { client: host.client(), shas, checks: true, react: (id) => void host.reactions.set(id, [{ id: 1, content: "+1", user: "maria" }]) };
}

function gitlab(): ConformanceSubject {
  const fake = new FakeGitLab();
  fake.seed(world, 42);
  const host = new GitLabHost({ credentials: async () => ({ baseUrl: fake.baseUrl, token: fake.token }), fetch: fake.fetch, sleep: async () => {} });
  return {
    client: host.client(1),
    shas,
    checks: true,
    react: (id) => void fake.awards.set(id, [{ id: 1, name: "thumbsup", user: { username: "maria" } }]),
    cloneSecret: fake.token,
  };
}

function bitbucket(): ConformanceSubject {
  const fake = new FakeBitbucket();
  fake.seed(world);
  const host = new BitbucketHost({ credentials: async () => ({ apiUrl: fake.apiUrl, workspace: fake.workspace, token: fake.token }), fetch: fake.fetch, sleep: async () => {} });
  return { client: host.client(1), shas, checks: true, cloneSecret: fake.token };
}

describe.each([
  ["GitHub", github],
  ["GitLab", gitlab],
  ["Bitbucket", bitbucket],
])("GitClient conformance: %s", (label, make) => {
  gitClientConformance("R3.6", label, make);
});
