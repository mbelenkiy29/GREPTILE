import { createAppJwt, normalizePem } from "./app";
import type {
  ChangedFile,
  GitClient,
  GitHost,
  IssueComment,
  NewInlineComment,
  PullRequest,
  PullRequestFile,
  RemoteInstallation,
  RemoteRepo,
  ReviewComment,
} from "@/lib/git/types";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub REST payloads are mapped field by field below */

export class GitHubHost implements GitHost {
  readonly provider = "github";
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly config: GitHubAppConfig) {
    this.apiUrl = (config.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = config.fetch ?? fetch;
  }

  private appJwt() {
    return createAppJwt(this.config.appId, normalizePem(this.config.privateKey));
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; token: string; accept?: string }): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: init.accept ?? "application/vnd.github+json",
        authorization: `Bearer ${init.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "openreview",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      throw new GitHubError(res.status, `GitHub ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Follows `per_page=100` pagination via the Link header. */
  async paginate<T>(path: string, token: string, pick: (page: any) => T[] = (p) => p as T[]): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      const res: Response = await this.fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "openreview",
        },
      });
      if (!res.ok) throw new GitHubError(res.status, `GitHub GET ${url} failed: ${res.status} ${await res.text()}`);
      out.push(...pick(await res.json()));
      const next: RegExpMatchArray | null | undefined = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
      url = next?.[1] ?? null;
    }
    return out;
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const res = await this.request<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", token: this.appJwt() },
    );
    this.tokens.set(installationId, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }

  async getInstallation(installationId: number): Promise<RemoteInstallation> {
    const res = await this.request<any>(`/app/installations/${installationId}`, { token: this.appJwt() });
    return { id: res.id, accountLogin: res.account?.login ?? "" };
  }

  async listInstallationRepos(installationId: number): Promise<RemoteRepo[]> {
    const token = await this.installationToken(installationId);
    const repos = await this.paginate<any>("/installation/repositories", token, (p) => p.repositories);
    return repos.map(toRemoteRepo);
  }

  client(installationId: number): GitClient {
    return new GitHubClient(this, installationId);
  }
}

export function toRemoteRepo(r: any): RemoteRepo {
  return { id: r.id, fullName: r.full_name, defaultBranch: r.default_branch ?? "main", private: Boolean(r.private) };
}

function toReviewComment(c: any): ReviewComment {
  return {
    id: c.id,
    path: c.path,
    line: c.line ?? null,
    body: c.body ?? "",
    author: c.user?.login ?? "",
    inReplyTo: c.in_reply_to_id ?? null,
  };
}

function toIssueComment(c: any): IssueComment {
  return { id: c.id, body: c.body ?? "", author: c.user?.login ?? "" };
}

class GitHubClient implements GitClient {
  constructor(
    private readonly host: GitHubHost,
    private readonly installationId: number,
  ) {}

  private token() {
    return this.host.installationToken(this.installationId);
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown; accept?: string } = {}) {
    return this.host.request<T>(path, { ...init, token: await this.token() });
  }

  async cloneUrl(repo: string) {
    return `https://x-access-token:${await this.token()}@github.com/${repo}.git`;
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const pr = await this.req<any>(`/repos/${repo}/pulls/${number}`);
    return {
      number: pr.number,
      title: pr.title ?? "",
      body: pr.body ?? "",
      author: pr.user?.login ?? "",
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      state: pr.state === "open" ? "open" : "closed",
      draft: Boolean(pr.draft),
    };
  }

  async listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]> {
    const files = await this.host.paginate<any>(`/repos/${repo}/pulls/${number}/files`, await this.token());
    return files.map((f) => ({ path: f.filename, previousPath: f.previous_filename, status: f.status, patch: f.patch }));
  }

  async getFileContent(repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.req<any>(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
      if (Array.isArray(res) || res.type !== "file" || typeof res.content !== "string") return null;
      return Buffer.from(res.content, "base64").toString("utf8");
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async listTree(repo: string, ref: string): Promise<string[]> {
    const res = await this.req<any>(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    return (res.tree ?? []).filter((t: any) => t.type === "blob").map((t: any) => t.path as string);
  }

  async compareCommits(repo: string, base: string, head: string): Promise<ChangedFile[]> {
    const res = await this.req<any>(`/repos/${repo}/compare/${base}...${head}`);
    return (res.files ?? []).map((f: any) => ({ path: f.filename, previousPath: f.previous_filename, status: f.status }));
  }

  async listIssueComments(repo: string, number: number) {
    const comments = await this.host.paginate<any>(`/repos/${repo}/issues/${number}/comments`, await this.token());
    return comments.map(toIssueComment);
  }

  async createIssueComment(repo: string, number: number, body: string) {
    return toIssueComment(await this.req<any>(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body } }));
  }

  async updateIssueComment(repo: string, commentId: number, body: string) {
    return toIssueComment(await this.req<any>(`/repos/${repo}/issues/comments/${commentId}`, { method: "PATCH", body: { body } }));
  }

  async listReviewComments(repo: string, number: number) {
    const comments = await this.host.paginate<any>(`/repos/${repo}/pulls/${number}/comments`, await this.token());
    return comments.map(toReviewComment);
  }

  async listReviewCommentReactions(repo: string, commentId: number) {
    const reactions = await this.host.paginate<any>(`/repos/${repo}/pulls/comments/${commentId}/reactions`, await this.token());
    return reactions.map((r) => ({ id: r.id as number, content: r.content as string, user: r.user?.login ?? "" }));
  }

  async createReview(
    repo: string,
    number: number,
    review: { commitId: string; body: string; comments: NewInlineComment[] },
  ) {
    const res = await this.req<any>(`/repos/${repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: {
        commit_id: review.commitId,
        event: "COMMENT",
        body: review.body,
        comments: review.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT",
          ...(c.startLine !== undefined && c.startLine < c.line ? { start_line: c.startLine, start_side: "RIGHT" } : {}),
          body: c.body,
        })),
      },
    });
    const posted = await this.host.paginate<any>(
      `/repos/${repo}/pulls/${number}/reviews/${res.id}/comments`,
      await this.token(),
    );
    return { id: res.id as number, comments: posted.map(toReviewComment) };
  }
}
