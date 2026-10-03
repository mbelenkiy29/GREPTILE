/**
 * GitClient conformance (R3.6): the same provider-neutral expectations for every method, run against GitHub (the
 * in-memory host), GitLab, and Bitbucket Cloud (their REST APIs faked behind an injected fetch).
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import { BitbucketHost } from "@/lib/bitbucket/client";
import type { GitClient } from "@/lib/git/types";
import { GitLabHost } from "@/lib/gitlab/client";
import { FakeBitbucket, FakeGitLab, type ScmWorld } from "./helpers/fake-scm";
import { FakeGitHost } from "./helpers/fake-git";

beforeAll(() => {
  vi.stubEnv("APP_SECRET", "conformance-secret-0123456789");
});

const BASE = "a1".repeat(20);
const MID = "b2".repeat(20);
const HEAD = "c3".repeat(20);
const PATH = "src/app.ts";
const PATCH = "@@ -1,3 +1,4 @@\n line1\n-old\n+new\n+added\n line3";
const CONTENT = "line1\nnew\nadded\nline3\n";
const MARKER = "<!-- openreview:fp=0123456789abcdef -->";

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

interface Subject {
  name: string;
  client: GitClient;
  /** Adds a 👍 by maria on an inline comment, where the host has reactions. */
  react?: (commentId: number) => void;
  cloneSecret?: string;
}

function github(): Subject {
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
  return { name: "github", client: host.client(), react: (id) => host.reactions.set(id, [{ id: 1, content: "+1", user: "maria" }]) };
}

function gitlab(): Subject {
  const fake = new FakeGitLab();
  fake.seed(world, 42);
  const host = new GitLabHost({ credentials: async () => ({ baseUrl: fake.baseUrl, token: fake.token }), fetch: fake.fetch, sleep: async () => {} });
  return {
    name: "gitlab",
    client: host.client(1),
    react: (id) => fake.awards.set(id, [{ id: 1, name: "thumbsup", user: { username: "maria" } }]),
    cloneSecret: fake.token,
  };
}

function bitbucket(): Subject {
  const fake = new FakeBitbucket();
  fake.seed(world);
  const host = new BitbucketHost({ credentials: async () => ({ apiUrl: fake.apiUrl, workspace: fake.workspace, token: fake.token }), fetch: fake.fetch, sleep: async () => {} });
  return { name: "bitbucket", client: host.client(1), cloneSecret: fake.token };
}

describe.each([
  ["GitHub", github],
  ["GitLab", gitlab],
  ["Bitbucket", bitbucket],
])("GitClient conformance: %s", (label, make) => {
  test(`R3.6 ${label} reads the pull request, its files, file contents, tree, comparisons, commits, reviews, and checks`, async () => {
    const { client } = make();
    expect(await client.getPullRequest("acme/shop", 7)).toMatchObject({
      number: 7,
      title: "Add things",
      body: "Adds things.",
      author: "dev",
      headSha: HEAD,
      baseSha: BASE,
      baseRef: "main",
      headRef: "feature",
      state: "open",
      draft: false,
    });
    expect(await client.listPullRequestFiles("acme/shop", 7)).toEqual([{ path: PATH, status: "modified", patch: PATCH }]);
    expect(await client.getFileContent("acme/shop", PATH, HEAD)).toBe(CONTENT);
    expect(await client.getFileContent("acme/shop", "missing.ts", HEAD)).toBeNull();
    expect(await client.listTree("acme/shop", HEAD)).toEqual(expect.arrayContaining([PATH, "README.md"]));
    expect(await client.compareCommits("acme/shop", BASE, HEAD)).toEqual([{ path: PATH, status: "modified" }]);
    expect((await client.listPullRequestCommits("acme/shop", 7)).map((c) => c.sha)).toEqual([MID, HEAD]);
    expect(await client.listReviews("acme/shop", 7)).toEqual([expect.objectContaining({ author: "maria", state: "APPROVED" })]);
    expect(await client.listCheckRuns("acme/shop", HEAD)).toEqual([expect.objectContaining({ status: "completed", conclusion: "success" })]);
  });

  test(`R3.6 ${label} creates, lists, and edits pull request comments in place`, async () => {
    const { client } = make();
    const created = await client.createIssueComment("acme/shop", 7, `<!-- openreview:summary -->\n## Summary`);
    expect((await client.listIssueComments("acme/shop", 7)).map((c) => c.body)).toEqual([`<!-- openreview:summary -->\n## Summary`]);
    await client.updateIssueComment("acme/shop", 7, created.id, `<!-- openreview:summary -->\n## Updated`);
    const listed = await client.listIssueComments("acme/shop", 7);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, body: `<!-- openreview:summary -->\n## Updated` });
  });

  test(`R3.6 ${label} posts inline review comments, threads replies, edits them, and lists reactions`, async () => {
    const subject = make();
    const { client } = subject;
    const body = `**Bug**\n\nDetails.\n\n${MARKER}`;
    const review = await client.createReview("acme/shop", 7, { commitId: HEAD, body: "", comments: [{ path: PATH, line: 3, body }] });
    expect(review.comments).toEqual([expect.objectContaining({ path: PATH, line: 3, body })]);
    const root = review.comments[0]!.id;

    const listed = await client.listReviewComments("acme/shop", 7);
    expect(listed).toEqual([expect.objectContaining({ id: root, path: PATH, line: 3, body })]);
    // Markers survive the round trip, so findings are never posted twice.
    expect(listed[0]!.body.endsWith(MARKER)).toBe(true);

    const reply = await client.replyToReviewComment("acme/shop", 7, root, "Thanks!");
    expect(reply).toMatchObject({ body: "Thanks!", inReplyTo: root, path: PATH });
    expect((await client.listReviewComments("acme/shop", 7)).find((c) => c.id === reply.id)).toMatchObject({ inReplyTo: root });

    const edited = await client.updateReviewComment("acme/shop", 7, root, `✅ Resolved in abc1234\n\n${body}`);
    expect(edited).toMatchObject({ id: root, body: `✅ Resolved in abc1234\n\n${body}` });

    subject.react?.(root);
    const reactions = await client.listReviewCommentReactions("acme/shop", 7, root);
    if (subject.react) expect(reactions).toEqual([expect.objectContaining({ content: "+1", user: "maria" })]);
    else expect(reactions).toEqual([]);
  });

  test(`R3.6 ${label} gives a clone URL carrying credentials`, async () => {
    const subject = make();
    const url = new URL(await subject.client.cloneUrl("acme/shop"));
    expect(url.pathname).toBe("/acme/shop.git");
    expect(url.password).not.toBe("");
    if (subject.cloneSecret) expect(decodeURIComponent(url.password)).toBe(subject.cloneSecret);
  });
});
