/**
 * Provider-neutral view of a git host. GitHub implements it today; GitLab and
 * Bitbucket (R3.6) plug in behind the same interface.
 */

export interface RemoteInstallation {
  id: number;
  accountLogin: string;
}

export interface RemoteRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
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
}

export interface NewInlineComment {
  path: string;
  line: number;
  body: string;
}

export interface GitClient {
  /** HTTPS clone URL carrying short-lived credentials. */
  cloneUrl(repo: string): Promise<string>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]>;
  getFileContent(repo: string, path: string, ref: string): Promise<string | null>;
  compareCommits(repo: string, base: string, head: string): Promise<ChangedFile[]>;
  listIssueComments(repo: string, number: number): Promise<IssueComment[]>;
  createIssueComment(repo: string, number: number, body: string): Promise<IssueComment>;
  updateIssueComment(repo: string, commentId: number, body: string): Promise<IssueComment>;
  listReviewComments(repo: string, number: number): Promise<ReviewComment[]>;
  /** Posts a review with inline comments on the RIGHT side of the diff at `commitId`. */
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
