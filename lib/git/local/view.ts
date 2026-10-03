/**
 * Data for the dashboard's local pull request pages (R6.22): the diff of a local pull request with its inline comment
 * threads, its conversation, and reviews, read from the bare repository and the store. Tenant-scoped by the
 * caller's org.
 */
import { and, eq } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { installations, repos } from "@/lib/db/schema";
import type { PullRequestFile } from "@/lib/git/types";
import { commitsBetween, diffFiles, repoDir, showCommit, showFile, treePaths } from "./repo";
import { getLocalPullRequest, getLocalPullRequestById, listLocalComments, LOCAL_PROVIDER, refreshLocalPullRequest, type LocalCommentRow, type LocalPullRequestRow } from "./store";

/** A connected local repository of the org, by full name. */
export async function findLocalRepo(db: Db, orgId: string, fullName: string) {
  const [row] = await db
    .select({ id: repos.id, fullName: repos.fullName, defaultBranch: repos.defaultBranch })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(scoped(repos, orgId, eq(repos.fullName, fullName)), eq(installations.provider, LOCAL_PROVIDER)));
  return row;
}

/** The row id of a local pull request, from its repository and number (what dashboard links carry). */
export async function findLocalPullRequestId(db: Db, orgId: string, fullName: string, number: number): Promise<number | undefined> {
  const repo = await findLocalRepo(db, orgId, fullName);
  if (!repo) return undefined;
  return (await getLocalPullRequest(db, orgId, repo.id, number))?.id;
}

export interface LocalThread {
  root: LocalCommentRow;
  replies: LocalCommentRow[];
}

export interface LocalPullRequestView {
  pr: LocalPullRequestRow;
  repo: { id: number; fullName: string };
  files: (PullRequestFile & { threads: LocalThread[] })[];
  /** Threads whose file is no longer in the diff. */
  outdated: LocalThread[];
  conversation: LocalCommentRow[];
  reviews: LocalCommentRow[];
  commits: { sha: string; message: string; author: string }[];
}

export async function getLocalPullRequestView(db: Db, orgId: string, id: number, root: string): Promise<LocalPullRequestView | undefined> {
  const found = await getLocalPullRequestById(db, orgId, id);
  if (!found) return undefined;
  const [repo] = await db.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(scoped(repos, orgId, eq(repos.id, found.repoId)));
  if (!repo) return undefined;
  const pr = await refreshLocalPullRequest(db, root, repo.fullName, found);
  const dir = repoDir(root, repo.fullName);
  const [files, comments, commits] = await Promise.all([diffFiles(dir, pr.baseSha, pr.headSha), listLocalComments(db, pr), commitsBetween(dir, pr.baseSha, pr.headSha)]);
  const inline = comments.filter((c) => c.kind === "review_comment");
  const threads: LocalThread[] = inline.filter((c) => !c.inReplyTo).map((root) => ({ root, replies: inline.filter((c) => c.inReplyTo === root.id) }));
  const paths = new Set(files.map((f) => f.path));
  return {
    pr,
    repo,
    files: files.map((f) => ({ ...f, threads: threads.filter((t) => t.root.path === f.path) })),
    outdated: threads.filter((t) => !t.root.path || !paths.has(t.root.path)),
    conversation: comments.filter((c) => c.kind === "issue"),
    reviews: comments.filter((c) => c.kind === "review"),
    commits: commits.map((c) => ({ sha: c.sha, message: c.message, author: c.author })),
  };
}

export type LocalBrowseView =
  | { kind: "file"; repo: string; ref: string; path: string; content: string }
  | { kind: "commit"; repo: string; ref: string; text: string }
  | { kind: "tree"; repo: string; ref: string; paths: string[] };

/** A file, a commit, or the file list of a connected local repository, for the browse page. */
export async function browseLocalRepo(db: Db, orgId: string, root: string, q: { repo: string; ref?: string; path?: string; view?: string }): Promise<LocalBrowseView | undefined> {
  const repo = await findLocalRepo(db, orgId, q.repo);
  if (!repo) return undefined;
  const dir = repoDir(root, repo.fullName);
  const ref = q.ref || repo.defaultBranch;
  if (q.path) {
    const content = await showFile(dir, ref, q.path);
    return content === null ? undefined : { kind: "file", repo: repo.fullName, ref, path: q.path, content };
  }
  if (q.view === "commit") {
    const text = await showCommit(dir, ref).catch(() => null);
    return text === null ? undefined : { kind: "commit", repo: repo.fullName, ref, text };
  }
  return { kind: "tree", repo: repo.fullName, ref, paths: await treePaths(dir, ref) };
}
