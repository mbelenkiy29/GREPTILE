/**
 * The GitClient conformance suite (R3.6): the same provider-neutral expectations for every method, run against each
 * git host. `tests/r3.6-conformance.test.ts` runs it for GitHub, GitLab, and Bitbucket; `tests/r6.22-local-host.test.ts`
 * for the local demo host. Each subject serves the same world: PR #7 of acme/shop (base → mid → head commits) that
 * changes src/app.ts, approved by maria, with one passing check where the host has CI.
 */
import { expect, test } from "vitest";
import type { GitClient } from "@/lib/git/types";

export const PATH = "src/app.ts";
export const PATCH = "@@ -1,3 +1,4 @@\n line1\n-old\n+new\n+added\n line3";
export const BASE_CONTENT = "line1\nold\nline3\n";
export const MID_CONTENT = "line1\nnew\nline3\n";
export const CONTENT = "line1\nnew\nadded\nline3\n";
export const README = "# shop\n";
const MARKER = "<!-- openreview:fp=0123456789abcdef -->";

export interface ConformanceSubject {
  client: GitClient;
  /** The world's commits on this host (fixed fake shas, or real ones for git-backed hosts). */
  shas: { base: string; mid: string; head: string };
  /** Adds a 👍 by maria on an inline comment, where the host has reactions. */
  react?: (commentId: number) => Promise<void> | void;
  /** The token the clone URL must carry (hosts with credentials). */
  cloneSecret?: string;
  /** Whether the host runs CI checks (the local host has none). */
  checks: boolean;
}

/**
 * Registers the conformance tests; titles start with `id` (the feature they verify) followed by `label`. `clone`:
 * `https` clone URLs carry credentials; the local host clones from a `file://` path.
 */
export function gitClientConformance(id: string, label: string, make: () => ConformanceSubject | Promise<ConformanceSubject>, clone: "https" | "file" = "https") {
  test(`${id} ${label} reads the pull request, its files, file contents, tree, comparisons, commits, reviews, and checks`, async () => {
    const { client, shas, checks } = await make();
    expect(await client.getPullRequest("acme/shop", 7)).toMatchObject({
      number: 7,
      title: "Add things",
      body: "Adds things.",
      author: "dev",
      headSha: shas.head,
      baseSha: shas.base,
      baseRef: "main",
      headRef: "feature",
      state: "open",
      draft: false,
    });
    expect(await client.listPullRequestFiles("acme/shop", 7)).toEqual([{ path: PATH, status: "modified", patch: PATCH }]);
    expect(await client.getFileContent("acme/shop", PATH, shas.head)).toBe(CONTENT);
    expect(await client.getFileContent("acme/shop", "missing.ts", shas.head)).toBeNull();
    expect(await client.listTree("acme/shop", shas.head)).toEqual(expect.arrayContaining([PATH, "README.md"]));
    expect(await client.compareCommits("acme/shop", shas.base, shas.head)).toEqual([{ path: PATH, status: "modified" }]);
    expect((await client.listPullRequestCommits("acme/shop", 7)).map((c) => c.sha)).toEqual([shas.mid, shas.head]);
    expect(await client.listReviews("acme/shop", 7)).toEqual([expect.objectContaining({ author: "maria", state: "APPROVED" })]);
    const runs = await client.listCheckRuns("acme/shop", shas.head);
    if (checks) expect(runs).toEqual([expect.objectContaining({ status: "completed", conclusion: "success" })]);
    else expect(runs).toEqual([]);
  });

  test(`${id} ${label} creates, lists, and edits pull request comments in place`, async () => {
    const { client } = await make();
    const created = await client.createIssueComment("acme/shop", 7, `<!-- openreview:summary -->\n## Summary`);
    expect((await client.listIssueComments("acme/shop", 7)).map((c) => c.body)).toEqual([`<!-- openreview:summary -->\n## Summary`]);
    await client.updateIssueComment("acme/shop", 7, created.id, `<!-- openreview:summary -->\n## Updated`);
    const listed = await client.listIssueComments("acme/shop", 7);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, body: `<!-- openreview:summary -->\n## Updated` });
  });

  test(`${id} ${label} posts inline review comments, threads replies, edits them, and lists reactions`, async () => {
    const subject = await make();
    const { client } = subject;
    const body = `**Bug**\n\nDetails.\n\n${MARKER}`;
    const review = await client.createReview("acme/shop", 7, { commitId: subject.shas.head, body: "", comments: [{ path: PATH, line: 3, body }] });
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

    await subject.react?.(root);
    const reactions = await client.listReviewCommentReactions("acme/shop", 7, root);
    if (subject.react) expect(reactions).toEqual([expect.objectContaining({ content: "+1", user: "maria" })]);
    else expect(reactions).toEqual([]);
  });

  test(`${id} ${label} gives a clone URL ${clone === "file" ? "pointing at the local bare repository" : "carrying credentials"}`, async () => {
    const subject = await make();
    const url = new URL(await subject.client.cloneUrl("acme/shop"));
    if (clone === "file") {
      expect(url.protocol).toBe("file:");
      expect(url.pathname.endsWith("/acme/shop.git")).toBe(true);
      return;
    }
    expect(url.pathname).toBe("/acme/shop.git");
    expect(url.password).not.toBe("");
    if (subject.cloneSecret) expect(decodeURIComponent(url.password)).toBe(subject.cloneSecret);
  });
}
