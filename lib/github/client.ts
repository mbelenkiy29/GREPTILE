import { z } from "zod";
import { createAppJwt, normalizePem } from "./app";
import { log as rootLog, type Logger } from "@/lib/log";
import type {
  ChangedFile,
  CheckRun,
  GitClient,
  GitHost,
  IssueComment,
  NewInlineComment,
  PullRequest,
  PullRequestCommit,
  PullRequestFile,
  PullRequestReview,
  Reaction,
  RemoteInstallation,
  RemoteRepo,
  ReviewComment,
} from "@/lib/git/types";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  /** REST API base (GitHub Enterprise Server: `https://ghe.example.com/api/v3`). */
  apiUrl?: string;
  /** Web origin; clone URLs derive from it (GitHub Enterprise Server: `https://ghe.example.com`). */
  webUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch milliseconds (token expiry, rate-limit resets, app JWTs). */
  now?: () => number;
  log?: Logger;
  /**
   * Longest single wait (rate-limit reset or retry backoff) before failing fast with `GitHubError.retryAfterMs`.
   * Defaults to {@link MAX_RATE_LIMIT_WAIT_MS}; request-path callers (webhooks) use a short cap to answer in time.
   */
  maxWaitMs?: number;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set when GitHub rate-limited the request: how long to wait before trying again. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** How a request authenticates: as the app (JWT), as one installation (cached token), or with a given token. */
export type GitHubAuth = { kind: "app" } | { kind: "installation"; installationId: number } | { kind: "token"; token: string };

export interface GitHubRequest {
  method?: string;
  body?: unknown;
  accept?: string;
  auth: GitHubAuth;
  /** Safe to retry after a 5xx or network error. Defaults to true for every method except POST. */
  idempotent?: boolean;
}

/** Attempts per request, including the first. A 401 token refresh does not count. */
export const MAX_ATTEMPTS = 3;
/** Longest we wait for a rate limit to clear before retrying; longer waits fail fast so the job retries later. */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- response schemas (GitHub REST payloads are external input) ----

const user = z.object({ login: z.string() }).nullish();

const installationSchema = z.object({
  id: z.number(),
  account: z.object({ login: z.string().optional(), slug: z.string().optional(), type: z.string().optional() }).nullish(),
  target_type: z.string().optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  repository_selection: z.string().optional(),
});

export const repoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  default_branch: z.string().nullish(),
  private: z.boolean().nullish(),
  archived: z.boolean().nullish(),
});

const fileStatus = z
  .enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"])
  .catch("modified");

const prFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: fileStatus,
  patch: z.string().optional(),
});

const prSchema = z.object({
  number: z.number(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  user,
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ sha: z.string(), ref: z.string() }),
  state: z.string(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  html_url: z.string().nullish(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
});

const prCommitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string().nullish(),
    author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
  }),
  author: user,
});

const prReviewSchema = z.object({
  id: z.number(),
  user,
  state: z.string().nullish(),
  body: z.string().nullish(),
  commit_id: z.string().nullish(),
  submitted_at: z.string().nullish(),
});

const checkRunSchema = z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullish() });

const reviewCommentSchema = z.object({
  id: z.number(),
  path: z.string().nullish(),
  line: z.number().nullish(),
  body: z.string().nullish(),
  user,
  in_reply_to_id: z.number().nullish(),
});

const issueCommentSchema = z.object({ id: z.number(), body: z.string().nullish(), user });
const reactionSchema = z.object({ id: z.number(), content: z.string(), user });
const tokenSchema = z.object({ token: z.string(), expires_at: z.string() });
const contentSchema = z.union([
  z.array(z.unknown()),
  z.object({ type: z.string(), content: z.string().optional(), encoding: z.string().optional() }),
]);
const treeSchema = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string() })).default([]) });
const compareSchema = z.object({ files: z.array(prFileSchema).default([]) });

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`Unexpected GitHub response for ${what}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
}

/** Wait before retrying a rate-limited response, from `retry-after` or `x-ratelimit-reset`; undefined if neither applies. */
export function rateLimitWaitMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + 1000;
    return MAX_RATE_LIMIT_WAIT_MS;
  }
  return undefined;
}

export class GitHubHost implements GitHost {
  readonly provider = "github";
  readonly apiUrl: string;
  readonly webUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly maxWaitMs: number;
  /** Installation tokens live in memory only; they are never persisted or logged. */
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();
  private readonly minting = new Map<number, Promise<string>>();

  constructor(private readonly config: GitHubAppConfig) {
    this.apiUrl = (config.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.webUrl = (config.webUrl ?? "https://github.com").replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? fetch;
    this.sleep = config.sleep ?? defaultSleep;
    this.now = config.now ?? Date.now;
    this.log = config.log ?? rootLog.child({ component: "github" });
    this.maxWaitMs = config.maxWaitMs ?? MAX_RATE_LIMIT_WAIT_MS;
  }

  private appJwt() {
    return createAppJwt(this.config.appId, normalizePem(this.config.privateKey), this.now());
  }

  private async authorization(auth: GitHubAuth): Promise<string> {
    if (auth.kind === "app") return `Bearer ${this.appJwt()}`;
    if (auth.kind === "token") return `Bearer ${auth.token}`;
    return `Bearer ${await this.installationToken(auth.installationId)}`;
  }

  /**
   * Sends one REST call with retries: 502/503/504 and network errors (idempotent requests only) back off
   * exponentially; rate limits (429, or 403 with `retry-after` / `x-ratelimit-remaining: 0` / a secondary-limit
   * message) wait for the reset when it is at most a minute away. An installation token GitHub rejects (401) is
   * dropped and minted again once. Every attempt is logged without credentials or query strings.
   */
  private async send(url: string, init: GitHubRequest): Promise<Response> {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const idempotent = init.idempotent ?? method !== "POST";
    const log = init.auth.kind === "installation" ? this.log.child({ installationId: init.auth.installationId }) : this.log;
    let attempt = 0;
    let refreshedToken = false;
    for (;;) {
      attempt++;
      const started = performance.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            accept: init.accept ?? "application/vnd.github+json",
            authorization: await this.authorization(init.auth),
            "x-github-api-version": "2022-11-28",
            "user-agent": "openreview",
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch (err) {
        const durationMs = Math.round(performance.now() - started);
        const waitMs = 1000 * 2 ** (attempt - 1);
        if (idempotent && attempt < MAX_ATTEMPTS && waitMs <= this.maxWaitMs) {
          log.warn("github request failed; retrying", { method, path, attempt, durationMs, waitMs, error: err instanceof Error ? err.message : String(err) });
          await this.sleep(waitMs);
          continue;
        }
        log.error("github request failed", { method, path, attempt, durationMs, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }

      const durationMs = Math.round(performance.now() - started);
      const remaining = res.headers.get("x-ratelimit-remaining");
      const fields = { method, path, status: res.status, durationMs, attempt, rateLimitRemaining: remaining === null ? undefined : Number(remaining) };
      if (res.ok) {
        log.debug("github request", fields);
        return res;
      }
      const text = await res.text();

      if (res.status === 401 && init.auth.kind === "installation" && !refreshedToken) {
        refreshedToken = true;
        attempt--;
        this.tokens.delete(init.auth.installationId);
        log.warn("github rejected the installation token; minting a new one", fields);
        continue;
      }

      const limitWait = rateLimitWaitMs(res.headers, this.now());
      const rateLimited =
        res.status === 429 || (res.status === 403 && (limitWait !== undefined || /secondary rate limit|abuse/i.test(text)));
      let waitMs: number | undefined;
      if (rateLimited) waitMs = limitWait ?? MAX_RATE_LIMIT_WAIT_MS;
      else if (RETRYABLE_STATUS.has(res.status) && idempotent) waitMs = 1000 * 2 ** (attempt - 1);

      if (waitMs !== undefined && waitMs <= this.maxWaitMs && attempt < MAX_ATTEMPTS) {
        log.warn(rateLimited ? "github rate limit hit; waiting before retry" : "github server error; retrying", { ...fields, waitMs });
        await this.sleep(waitMs);
        continue;
      }
      // Missing files and refs are routine (optional config files, deleted branches); other failures are worth seeing.
      (res.status === 404 ? log.debug : log.info)("github request failed", { ...fields, ...(rateLimited ? { waitMs } : {}) });
      throw new GitHubError(
        res.status,
        `GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`,
        rateLimited ? waitMs : undefined,
      );
    }
  }

  async request<T = unknown>(path: string, init: GitHubRequest): Promise<T> {
    const res = await this.send(`${this.apiUrl}${path}`, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Follows `per_page=100` pagination via the Link header (same origin as the API only). */
  async paginate(path: string, auth: GitHubAuth, pick: (page: unknown) => unknown[] = (p) => (Array.isArray(p) ? p : [])): Promise<unknown[]> {
    const out: unknown[] = [];
    const origin = new URL(this.apiUrl).origin;
    let url: string | null = `${this.apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      const res: Response = await this.send(url, { auth });
      out.push(...pick(await res.json()));
      const next: string | undefined = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      url = next && new URL(next).origin === origin ? next : null;
    }
    return out;
  }

  /** A cached installation token, minted again a minute before it expires. Concurrent callers share one mint. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const inflight = this.minting.get(installationId);
    if (inflight) return inflight;
    const mint = (async () => {
      const res = parse(
        tokenSchema,
        await this.request(`/app/installations/${installationId}/access_tokens`, { method: "POST", auth: { kind: "app" }, idempotent: true }),
        "installation token",
      );
      this.tokens.set(installationId, { token: res.token, expiresAt: Date.parse(res.expires_at) });
      return res.token;
    })();
    this.minting.set(installationId, mint);
    try {
      return await mint;
    } finally {
      this.minting.delete(installationId);
    }
  }

  async getInstallation(installationId: number): Promise<RemoteInstallation> {
    const res = parse(
      installationSchema,
      await this.request(`/app/installations/${installationId}`, { auth: { kind: "app" } }),
      "installation",
    );
    return {
      id: res.id,
      accountLogin: res.account?.login ?? res.account?.slug ?? "",
      accountType: res.account?.type ?? res.target_type,
      permissions: res.permissions,
      repositorySelection: res.repository_selection,
    };
  }

  async listInstallationRepos(installationId: number): Promise<RemoteRepo[]> {
    const repos = await this.paginate("/installation/repositories", { kind: "installation", installationId }, (p) =>
      parse(z.object({ repositories: z.array(z.unknown()) }), p, "installation repositories").repositories,
    );
    return repos.map((r) => toRemoteRepo(parse(repoSchema, r, "repository")));
  }

  client(installationId: number): GitClient {
    return new GitHubClient(this, installationId);
  }
}

export function toRemoteRepo(r: z.infer<typeof repoSchema>): RemoteRepo {
  return {
    id: r.id,
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? "main",
    private: Boolean(r.private),
    ...(typeof r.archived === "boolean" ? { archived: r.archived } : {}),
  };
}

function toReviewComment(raw: unknown): ReviewComment {
  const c = parse(reviewCommentSchema, raw, "review comment");
  return {
    id: c.id,
    path: c.path ?? "",
    line: c.line ?? null,
    body: c.body ?? "",
    author: c.user?.login ?? "",
    inReplyTo: c.in_reply_to_id ?? null,
  };
}

function toIssueComment(raw: unknown): IssueComment {
  const c = parse(issueCommentSchema, raw, "issue comment");
  return { id: c.id, body: c.body ?? "", author: c.user?.login ?? "" };
}

class GitHubClient implements GitClient {
  private readonly auth: GitHubAuth;

  constructor(
    private readonly host: GitHubHost,
    private readonly installationId: number,
  ) {
    this.auth = { kind: "installation", installationId };
  }

  private req(path: string, init: Omit<GitHubRequest, "auth"> = {}) {
    return this.host.request(path, { ...init, auth: this.auth });
  }

  private list(path: string) {
    return this.host.paginate(path, this.auth);
  }

  async cloneUrl(repo: string) {
    const url = new URL(`${this.host.webUrl}/${repo}.git`);
    url.username = "x-access-token";
    url.password = await this.host.installationToken(this.installationId);
    return url.toString();
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const pr = parse(prSchema, await this.req(`/repos/${repo}/pulls/${number}`), "pull request");
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
      merged: Boolean(pr.merged),
      ...(pr.html_url ? { url: pr.html_url } : {}),
      closedAt: pr.closed_at ?? null,
      mergedAt: pr.merged_at ?? null,
    };
  }

  async listPullRequestCommits(repo: string, number: number): Promise<PullRequestCommit[]> {
    return (await this.list(`/repos/${repo}/pulls/${number}/commits`)).map((raw) => {
      const c = parse(prCommitSchema, raw, "pull request commit");
      return {
        sha: c.sha,
        message: c.commit.message ?? "",
        author: c.author?.login ?? c.commit.author?.name ?? "",
        committedAt: c.commit.author?.date ?? null,
      };
    });
  }

  async listReviews(repo: string, number: number): Promise<PullRequestReview[]> {
    return (await this.list(`/repos/${repo}/pulls/${number}/reviews`)).map((raw) => {
      const r = parse(prReviewSchema, raw, "pull request review");
      return {
        id: r.id,
        author: r.user?.login ?? "",
        state: r.state ?? "",
        body: r.body ?? "",
        commitId: r.commit_id ?? null,
        submittedAt: r.submitted_at ?? null,
      };
    });
  }

  async listCheckRuns(repo: string, ref: string): Promise<CheckRun[]> {
    try {
      const runs = await this.host.paginate(`/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs`, this.auth, (page) =>
        parse(z.object({ check_runs: z.array(z.unknown()) }), page, "check runs").check_runs,
      );
      return runs.map((raw) => {
        const c = parse(checkRunSchema, raw, "check run");
        return { name: c.name, status: c.status, conclusion: c.conclusion ?? null };
      });
    } catch (err) {
      // `checks: read` is recommended, not required: without it the review simply has no CI context. A 403 that is
      // a (primary or secondary) rate limit carries retryAfterMs and is rethrown so the job is deferred.
      if (err instanceof GitHubError && err.retryAfterMs === undefined && (err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  }

  async listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]> {
    const files = await this.list(`/repos/${repo}/pulls/${number}/files`);
    return files.map((raw) => {
      const f = parse(prFileSchema, raw, "pull request file");
      return { path: f.filename, previousPath: f.previous_filename, status: f.status, patch: f.patch };
    });
  }

  async getFileContent(repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const res = parse(contentSchema, await this.req(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`), "file content");
      if (Array.isArray(res) || res.type !== "file" || typeof res.content !== "string") return null;
      return Buffer.from(res.content, "base64").toString("utf8");
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async listTree(repo: string, ref: string): Promise<string[]> {
    const res = parse(treeSchema, await this.req(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`), "tree");
    return res.tree.filter((t) => t.type === "blob").map((t) => t.path);
  }

  async compareCommits(repo: string, base: string, head: string): Promise<ChangedFile[]> {
    const res = parse(compareSchema, await this.req(`/repos/${repo}/compare/${base}...${head}`), "compare");
    return res.files.map((f) => ({ path: f.filename, previousPath: f.previous_filename, status: f.status }));
  }

  async listIssueComments(repo: string, number: number) {
    return (await this.list(`/repos/${repo}/issues/${number}/comments`)).map(toIssueComment);
  }

  async createIssueComment(repo: string, number: number, body: string) {
    return toIssueComment(await this.req(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body } }));
  }

  async updateIssueComment(repo: string, _number: number, commentId: number, body: string) {
    return toIssueComment(await this.req(`/repos/${repo}/issues/comments/${commentId}`, { method: "PATCH", body: { body } }));
  }

  async listReviewComments(repo: string, number: number) {
    return (await this.list(`/repos/${repo}/pulls/${number}/comments`)).map(toReviewComment);
  }

  async replyToReviewComment(repo: string, number: number, commentId: number, body: string) {
    return toReviewComment(
      await this.req(`/repos/${repo}/pulls/${number}/comments/${commentId}/replies`, { method: "POST", body: { body } }),
    );
  }

  async updateReviewComment(repo: string, _number: number, commentId: number, body: string) {
    return toReviewComment(await this.req(`/repos/${repo}/pulls/comments/${commentId}`, { method: "PATCH", body: { body } }));
  }

  async listReviewCommentReactions(repo: string, _number: number, commentId: number): Promise<Reaction[]> {
    return (await this.list(`/repos/${repo}/pulls/comments/${commentId}/reactions`)).map((raw) => {
      const r = parse(reactionSchema, raw, "reaction");
      return { id: r.id, content: r.content, user: r.user?.login ?? "" };
    });
  }

  async createReview(
    repo: string,
    number: number,
    review: { commitId: string; body: string; comments: NewInlineComment[] },
  ) {
    const res = parse(
      z.object({ id: z.number() }),
      await this.req(`/repos/${repo}/pulls/${number}/reviews`, {
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
      }),
      "review",
    );
    const posted = await this.list(`/repos/${repo}/pulls/${number}/reviews/${res.id}/comments`);
    return { id: res.id, comments: posted.map(toReviewComment) };
  }
}
