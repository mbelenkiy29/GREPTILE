/**
 * The local git host (R6.22 demo / local mode): a {@link GitHost} over bare git repositories on disk plus a Postgres
 * store of pull requests and comments, so the real pipeline (indexer, engine, publishing, conversations) runs end to
 * end without GitHub. Installation ids are local installations (`installations.provider = 'local'`); clone URLs are
 * `file://` paths. It refuses to exist unless demo mode is on (see `./guard.ts`).
 */
import type { Db } from "@/lib/db";
import type { LocalModeEnv } from "@/lib/env";
import type { GitClient, GitHost, IssueComment, PullRequest, RemoteInstallation, RemoteRepo, ReviewComment } from "@/lib/git/types";
import { LocalModeDisabledError, localModeBlocker } from "./guard";
import {
  changedFiles,
  commitsBetween,
  defaultBranchOf,
  diffFiles,
  fileUrl,
  listOwnerRepos,
  LocalRepoError,
  repoDir,
  resolveCommit,
  showFile,
  treePaths,
} from "./repo";
import {
  addLocalComment,
  getLocalComment,
  getLocalPullRequest,
  listLocalComments,
  LOCAL_PROVIDER,
  localExternalId,
  localInstallation,
  localRepo,
  refreshLocalPullRequest,
  updateLocalComment,
  type LocalCommentRow,
  type LocalPullRequestRow,
} from "./store";

/** Login the local host attributes OpenReview's own comments and reviews to. */
export const LOCAL_BOT_LOGIN = "openreview[bot]";

export interface LocalGitHostOptions {
  /** The database holding installations, repos, and the local pull request store (or a getter, resolved lazily). */
  db: Db | (() => Db);
  /** Directory of the bare repositories (LOCAL_GIT_ROOT). */
  root: string;
  /** The demo mode settings; the host refuses to be created when they do not enable local mode. */
  mode: Pick<LocalModeEnv, "NODE_ENV" | "DEMO_MODE" | "DEMO_MODE_ALLOW_PRODUCTION">;
  botLogin?: string;
}

function toIssueComment(c: LocalCommentRow): IssueComment {
  return { id: c.id, body: c.body, author: c.author };
}

function toReviewComment(c: LocalCommentRow): ReviewComment {
  return { id: c.id, path: c.path ?? "", line: c.line, body: c.body, author: c.author, inReplyTo: c.inReplyTo };
}

function toPullRequest(pr: LocalPullRequestRow): PullRequest {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    state: pr.state === "open" ? "open" : "closed",
    draft: pr.draft,
    merged: pr.state === "merged",
    closedAt: pr.closedAt?.toISOString() ?? null,
    mergedAt: pr.state === "merged" ? (pr.closedAt?.toISOString() ?? null) : null,
  };
}

export class LocalGitHost implements GitHost {
  readonly provider = LOCAL_PROVIDER;
  private readonly getDb: () => Db;
  private readonly botLogin: string;

  constructor(private readonly opts: LocalGitHostOptions) {
    const blocker = localModeBlocker(opts.mode);
    if (blocker) throw new LocalModeDisabledError(blocker);
    const db = opts.db;
    this.getDb = typeof db === "function" ? db : () => db;
    this.botLogin = opts.botLogin ?? LOCAL_BOT_LOGIN;
  }

  get root(): string {
    return this.opts.root;
  }

  async getInstallation(installationId: number): Promise<RemoteInstallation> {
    const row = await localInstallation(this.getDb(), installationId);
    if (!row) throw new LocalRepoError(`no local installation ${installationId}`);
    return {
      id: row.externalId,
      accountLogin: row.accountLogin,
      accountType: "Local",
      permissions: { metadata: "read", contents: "read", pull_requests: "write", issues: "write", checks: "read" },
      repositorySelection: "all",
    };
  }

  /** The bare repositories under `<root>/<account>/`. */
  async listInstallationRepos(installationId: number): Promise<RemoteRepo[]> {
    const row = await localInstallation(this.getDb(), installationId);
    if (!row) return [];
    const names = await listOwnerRepos(this.opts.root, row.accountLogin);
    return Promise.all(
      names.map(async (name) => {
        const fullName = `${row.accountLogin}/${name}`;
        return { id: localExternalId("local-repo", fullName), fullName, defaultBranch: await defaultBranchOf(repoDir(this.opts.root, fullName)), private: true };
      }),
    );
  }

  client(installationId: number): GitClient {
    const db = () => this.getDb();
    const root = this.opts.root;
    const bot = this.botLogin;
    const dirOf = (repo: string) => repoDir(root, repo);
    const pr = async (repo: string, number: number) => {
      const { repo: row } = await localRepo(db(), installationId, repo);
      const found = await getLocalPullRequest(db(), row.orgId, row.id, number);
      if (!found) throw new LocalRepoError(`no pull request ${repo}#${number}`);
      return refreshLocalPullRequest(db(), root, repo, found);
    };
    const comment = async (p: LocalPullRequestRow, id: number, kind: LocalCommentRow["kind"]) => {
      const c = await getLocalComment(db(), p, id, kind);
      if (!c) throw new LocalRepoError(`no ${kind === "issue" ? "comment" : "review comment"} ${id} on #${p.number}`);
      return c;
    };
    const ref = async (repo: string, r: string) => (await resolveCommit(dirOf(repo), r)) ?? r;

    return {
      cloneUrl: async (repo) => {
        await localRepo(db(), installationId, repo);
        return fileUrl(dirOf(repo));
      },
      getPullRequest: async (repo, number) => toPullRequest(await pr(repo, number)),
      listPullRequestFiles: async (repo, number) => {
        const p = await pr(repo, number);
        return diffFiles(dirOf(repo), p.baseSha, p.headSha);
      },
      getFileContent: async (repo, path, r) => {
        await localRepo(db(), installationId, repo);
        return showFile(dirOf(repo), r, path);
      },
      listTree: async (repo, r) => {
        await localRepo(db(), installationId, repo);
        return treePaths(dirOf(repo), r);
      },
      compareCommits: async (repo, base, head) => {
        await localRepo(db(), installationId, repo);
        return changedFiles(dirOf(repo), await ref(repo, base), await ref(repo, head));
      },
      listIssueComments: async (repo, number) => (await listLocalComments(db(), await pr(repo, number), "issue")).map(toIssueComment),
      createIssueComment: async (repo, number, body) => toIssueComment(await addLocalComment(db(), await pr(repo, number), { kind: "issue", body, author: bot })),
      updateIssueComment: async (repo, number, commentId, body) => {
        const p = await pr(repo, number);
        await comment(p, commentId, "issue");
        return toIssueComment((await updateLocalComment(db(), p, commentId, "issue", body))!);
      },
      listReviewComments: async (repo, number) => (await listLocalComments(db(), await pr(repo, number), "review_comment")).map(toReviewComment),
      replyToReviewComment: async (repo, number, commentId, body) => {
        const p = await pr(repo, number);
        const parent = await comment(p, commentId, "review_comment");
        // As on GitHub: replies attach to the thread's top-level comment.
        if (parent.inReplyTo) throw new LocalRepoError(`review comment ${commentId} is a reply; reply to ${parent.inReplyTo}`);
        const reply = await addLocalComment(db(), p, { kind: "review_comment", body, author: bot, path: parent.path, line: parent.line, inReplyTo: parent.id, commitSha: p.headSha });
        return toReviewComment(reply);
      },
      updateReviewComment: async (repo, number, commentId, body) => {
        const p = await pr(repo, number);
        await comment(p, commentId, "review_comment");
        return toReviewComment((await updateLocalComment(db(), p, commentId, "review_comment", body))!);
      },
      listReviewCommentReactions: async (repo, number, commentId) => (await comment(await pr(repo, number), commentId, "review_comment")).reactions,
      listPullRequestCommits: async (repo, number) => {
        const p = await pr(repo, number);
        return commitsBetween(dirOf(repo), p.baseSha, p.headSha);
      },
      listReviews: async (repo, number) =>
        (await listLocalComments(db(), await pr(repo, number), "review")).map((r) => ({
          id: r.id,
          author: r.author,
          state: r.state ?? "COMMENTED",
          body: r.body,
          commitId: r.commitSha,
          submittedAt: r.createdAt.toISOString(),
        })),
      // The local host runs no CI.
      listCheckRuns: async (repo) => {
        await localRepo(db(), installationId, repo);
        return [];
      },
      createReview: async (repo, number, review) => {
        const p = await pr(repo, number);
        const files = new Set((await diffFiles(dirOf(repo), p.baseSha, p.headSha)).map((f) => f.path));
        for (const c of review.comments) {
          // A git host rejects inline comments outside the pull request's files (GitHub answers 422).
          if (!files.has(c.path)) throw new LocalRepoError(`${c.path} is not part of the diff of #${number}`);
        }
        const submitted = await addLocalComment(db(), p, { kind: "review", body: review.body, author: bot, state: "COMMENTED", commitSha: review.commitId });
        const posted: ReviewComment[] = [];
        for (const c of review.comments) {
          const row = await addLocalComment(db(), p, {
            kind: "review_comment",
            body: c.body,
            author: bot,
            path: c.path,
            line: c.line,
            startLine: c.startLine ?? null,
            reviewId: submitted.id,
            commitSha: review.commitId,
          });
          posted.push(toReviewComment(row));
        }
        return { id: submitted.id, comments: posted };
      },
    };
  }
}
