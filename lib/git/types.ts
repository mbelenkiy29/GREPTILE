/**
 * Provider-neutral view of a git host (R3.6). GitHub (`lib/github`), GitLab (`lib/gitlab`), and Bitbucket Cloud
 * (`lib/bitbucket`) implement it; the indexer, review engine, pipeline, and conversations only use these interfaces.
 * A "pull request" is a GitLab merge request (`number` is its iid) or a Bitbucket pull request.
 */

/**
 * The git hosts OpenReview supports; `installations.provider` holds one of them. `local` is the demo / local mode
 * host (R6.22, `lib/git/local`), available only when DEMO_MODE is on outside production.
 */
export const GIT_PROVIDERS = ["github", "gitlab", "bitbucket", "local"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export function isGitProvider(value: unknown): value is GitProvider {
  return typeof value === "string" && (GIT_PROVIDERS as readonly string[]).includes(value);
}

export interface RemoteInstallation {
  id: number;
  accountLogin: string;
  /** `User` or `Organization`, when the host reports it. */
  accountType?: string;
  /** Permissions granted to the app, e.g. `{ pull_requests: "write" }`; absent when the host does not report them. */
  permissions?: Record<string, string>;
  /** `all` or `selected`. */
  repositorySelection?: string;
}

export interface RemoteRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /** Archived (read-only) on the host, when reported. */
  archived?: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  state: "open" | "closed";
  draft: boolean;
  /** Closed by merging; only meaningful when `state` is closed. */
  merged?: boolean;
  /** Web URL of the pull request, when the host reports it. */
  url?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
}

export interface PullRequestCommit {
  sha: string;
  message: string;
  author: string;
  committedAt: string | null;
}

/** A submitted review on a pull request (ours or a human's). */
export interface PullRequestReview {
  id: number;
  author: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state: string;
  body: string;
  commitId: string | null;
  submittedAt: string | null;
}

/** A CI check run on a commit. */
export interface CheckRun {
  name: string;
  /** queued, in_progress, completed, ... */
  status: string;
  /** success, failure, neutral, cancelled, skipped, timed_out, action_required; null while running. */
  conclusion: string | null;
}

export interface PullRequestFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  /** Unified diff hunk text; absent for binary or very large files. */
  patch?: string;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: PullRequestFile["status"];
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
}

export interface ReviewComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  author: string;
  /** Id of the comment this one replies to, for threaded replies. */
  inReplyTo?: number | null;
}

export interface Reaction {
  id: number;
  /** GitHub reaction content: "+1", "-1", "laugh", "heart", ... */
  content: string;
  user: string;
}

export interface NewInlineComment {
  path: string;
  /** Last line of the commented range (new-file numbering). */
  line: number;
  /** First line, for multi-line comments and suggestions. */
  startLine?: number;
  body: string;
}

export interface GitClient {
  /** HTTPS clone URL carrying short-lived credentials. */
  cloneUrl(repo: string): Promise<string>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]>;
  getFileContent(repo: string, path: string, ref: string): Promise<string | null>;
  /** Every file path in the repository at `ref`. */
  listTree(repo: string, ref: string): Promise<string[]>;
  compareCommits(repo: string, base: string, head: string): Promise<ChangedFile[]>;
  listIssueComments(repo: string, number: number): Promise<IssueComment[]>;
  createIssueComment(repo: string, number: number, body: string): Promise<IssueComment>;
  /** Edits a pull-request comment (GitLab and Bitbucket address comments through their pull request). */
  updateIssueComment(repo: string, number: number, commentId: number, body: string): Promise<IssueComment>;
  listReviewComments(repo: string, number: number): Promise<ReviewComment[]>;
  /**
   * Replies in an inline review thread. `commentId` must be the thread's top-level comment (GitHub does not
   * support replies to replies; GitLab replies in the comment's discussion; Bitbucket nests under the comment).
   */
  replyToReviewComment(repo: string, number: number, commentId: number, body: string): Promise<ReviewComment>;
  /** Edits an inline review comment in place (no new notification). */
  updateReviewComment(repo: string, number: number, commentId: number, body: string): Promise<ReviewComment>;
  /** Reactions on an inline comment, as GitHub reaction names (`+1`, `-1`, ...); empty where the host has none. */
  listReviewCommentReactions(repo: string, number: number, commentId: number): Promise<Reaction[]>;
  /** Commits on the pull request, oldest first (GitHub returns at most 250). */
  listPullRequestCommits(repo: string, number: number): Promise<PullRequestCommit[]>;
  /** Reviews submitted on the pull request. */
  listReviews(repo: string, number: number): Promise<PullRequestReview[]>;
  /** CI check runs on a commit; empty when the app may not read checks. */
  listCheckRuns(repo: string, ref: string): Promise<CheckRun[]>;
  /**
   * Posts a review with inline comments on the RIGHT side of the diff at `commitId` (GitHub: one review; GitLab: one
   * positioned discussion per comment; Bitbucket: one inline comment each).
   */
  createReview(
    repo: string,
    number: number,
    review: { commitId: string; body: string; comments: NewInlineComment[] },
  ): Promise<{ id: number; comments: ReviewComment[] }>;
}

export interface GitHost {
  readonly provider: string;
  getInstallation(installationId: number): Promise<RemoteInstallation>;
  listInstallationRepos(installationId: number): Promise<RemoteRepo[]>;
  client(installationId: number): GitClient;
}
