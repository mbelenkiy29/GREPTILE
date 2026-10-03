/**
 * GitLab (gitlab.com and self-managed) behind the provider-neutral {@link GitHost} / {@link GitClient} (R3.6).
 *
 * An org connects GitLab with a group or project access token (or a personal access token) that an admin enters in
 * Settings → Git providers; it is stored encrypted in `scm_credentials`. The host's "installation" is that credential:
 * `installations.external_id` is the credential id, and `credentials(id)` resolves its URL and token. A pull request is
 * a merge request (`number` is its iid); inline review comments are diff discussions positioned with the merge request
 * version's base/start/head shas; issue comments are merge request notes outside diff discussions.
 */
import { z } from "zod";
import { log as rootLog, type Logger } from "@/lib/log";
import { parsePatch } from "@/lib/review/diff";
import { isNotFound, ScmHttp, ScmHttpError } from "@/lib/scm/http";
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

/** A resolved GitLab connection: the instance origin (`https://gitlab.com`) and the access token. */
export interface GitLabConnection {
  baseUrl: string;
  token: string;
}

export interface GitLabHostConfig {
  /** Resolves an installation (credential) id to its connection. */
  credentials: (installationId: number) => Promise<GitLabConnection>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: Logger;
  maxWaitMs?: number;
}

/** Token scopes OpenReview needs: `api` (comments, discussions, hooks) and `read_repository` (clone). */
export const GITLAB_REQUIRED_SCOPES = ["api", "read_repository"] as const;
/** Project role needed to create project webhooks (Maintainer). */
export const GITLAB_MAINTAINER = 40;
/** Project role that can push (Developer); members at or above it may run state-changing commands. */
export const GITLAB_DEVELOPER = 30;

// ---- response schemas (GitLab payloads are external input) ----

const user = z.object({ id: z.number().optional(), username: z.string().optional(), name: z.string().optional() }).nullish();

export const gitlabProjectSchema = z.object({
  id: z.number(),
  path_with_namespace: z.string(),
  default_branch: z.string().nullish(),
  visibility: z.string().nullish(),
  archived: z.boolean().nullish(),
  web_url: z.string().nullish(),
});

const diffRefs = z.object({ base_sha: z.string().nullish(), head_sha: z.string().nullish(), start_sha: z.string().nullish() }).nullish();

const mrSchema = z.object({
  iid: z.number(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  author: user,
  sha: z.string().nullish(),
  diff_refs: diffRefs,
  source_branch: z.string(),
  target_branch: z.string(),
  state: z.string(),
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
  web_url: z.string().nullish(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
});

const versionSchema = z.object({ head_commit_sha: z.string(), base_commit_sha: z.string(), start_commit_sha: z.string() });

const diffSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  diff: z.string().nullish(),
  new_file: z.boolean().nullish(),
  renamed_file: z.boolean().nullish(),
  deleted_file: z.boolean().nullish(),
  too_large: z.boolean().nullish(),
  collapsed: z.boolean().nullish(),
});

const position = z
  .object({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish() })
  .nullish();

const noteSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  author: user,
  system: z.boolean().nullish(),
  type: z.string().nullish(),
  position,
});
type Note = z.infer<typeof noteSchema>;

const discussionSchema = z.object({ id: z.string(), individual_note: z.boolean().nullish(), notes: z.array(noteSchema).default([]) });
type Discussion = z.infer<typeof discussionSchema>;

const commitSchema = z.object({ id: z.string(), message: z.string().nullish(), author_name: z.string().nullish(), committed_date: z.string().nullish() });
const awardSchema = z.object({ id: z.number(), name: z.string(), user });
const approvalsSchema = z.object({ approved_by: z.array(z.object({ user })).default([]) });
const pipelineSchema = z.object({ id: z.number(), status: z.string(), source: z.string().nullish(), ref: z.string().nullish() });
const treeEntry = z.object({ path: z.string(), type: z.string() });
const compareSchema = z.object({ diffs: z.array(diffSchema).default([]) });

export const tokenSelfSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  scopes: z.array(z.string()).default([]),
  active: z.boolean().nullish(),
  revoked: z.boolean().nullish(),
  expires_at: z.string().nullish(),
  user_id: z.number().nullish(),
});
export type GitLabTokenInfo = z.infer<typeof tokenSelfSchema>;

export const gitlabUserSchema = z.object({ id: z.number(), username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish() });

const hookSchema = z.object({ id: z.number() });
const memberSchema = z.object({ access_level: z.number() });

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`Unexpected GitLab response for ${what}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
}

/** GitLab award emoji names as the GitHub reaction names the learning code understands. */
const AWARD_TO_REACTION: Record<string, string> = {
  thumbsup: "+1",
  thumbsdown: "-1",
  laughing: "laugh",
  tada: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

/** A GitLab pipeline status as a check run status and conclusion. */
export function pipelineCheck(status: string): Pick<CheckRun, "status" | "conclusion"> {
  switch (status) {
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failed":
      return { status: "completed", conclusion: "failure" };
    case "canceled":
    case "canceling":
      return { status: "completed", conclusion: "cancelled" };
    case "skipped":
      return { status: "completed", conclusion: "skipped" };
    case "manual":
      return { status: "completed", conclusion: "action_required" };
    case "running":
      return { status: "in_progress", conclusion: null };
    default:
      return { status: "queued", conclusion: null };
  }
}

export function toGitLabRemoteRepo(p: z.infer<typeof gitlabProjectSchema>): RemoteRepo {
  return {
    id: p.id,
    fullName: p.path_with_namespace,
    defaultBranch: p.default_branch ?? "main",
    private: p.visibility !== "public",
    ...(typeof p.archived === "boolean" ? { archived: p.archived } : {}),
  };
}

/** The project path as GitLab's `:id` URL segment. */
export const projectRef = (repo: string | number) => encodeURIComponent(String(repo));

/** REST access to one GitLab connection (`/api/v4`), with pagination by the `Link` header. */
export class GitLabApi {
  readonly apiUrl: string;
  readonly webUrl: string;

  constructor(
    private readonly http: ScmHttp,
    readonly connection: GitLabConnection,
  ) {
    this.webUrl = connection.baseUrl.replace(/\/+$/, "");
    this.apiUrl = `${this.webUrl}/api/v4`;
  }

  private headers() {
    return { "private-token": this.connection.token };
  }

  async send(path: string, init: { method?: string; body?: unknown; accept?: string; idempotent?: boolean } = {}) {
    return this.http.send(`${this.apiUrl}${path}`, { ...init, headers: this.headers() });
  }

  async request<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotent?: boolean } = {}): Promise<T> {
    return this.http.json<T>(`${this.apiUrl}${path}`, { ...init, headers: this.headers() });
  }

  /** Every page of a list endpoint (`per_page=100`), following `rel="next"` links on the API's own origin. */
  async paginate(path: string): Promise<unknown[]> {
    const out: unknown[] = [];
    const origin = new URL(this.apiUrl).origin;
    let url: string | null = `${this.apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let pages = 0; url && pages < 500; pages++) {
      const res: Response = await this.http.send(url, { headers: this.headers() });
      const body: unknown = await res.json();
      if (Array.isArray(body)) out.push(...body);
      const next: string | undefined = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      url = next && new URL(next).origin === origin ? next : null;
    }
    return out;
  }

  // ---- connection management (Settings → Git providers) ----

  /** The token's own record: name, scopes, expiry (`GET /personal_access_tokens/self`). */
  async tokenSelf(): Promise<GitLabTokenInfo> {
    return parse(tokenSelfSchema, await this.request("/personal_access_tokens/self"), "token");
  }

  /** The user the token acts as (a bot user for group and project access tokens). */
  async currentUser() {
    return parse(gitlabUserSchema, await this.request("/user"), "user");
  }

  /** Projects the token can administer hooks on (Maintainer or higher), not archived. */
  async listProjects(): Promise<RemoteRepo[]> {
    const rows = await this.paginate(`/projects?membership=true&min_access_level=${GITLAB_MAINTAINER}&archived=false&order_by=path&sort=asc`);
    return rows.map((r) => toGitLabRemoteRepo(parse(gitlabProjectSchema, r, "project")));
  }

  async getProject(id: number | string): Promise<RemoteRepo> {
    return toGitLabRemoteRepo(parse(gitlabProjectSchema, await this.request(`/projects/${projectRef(id)}`), "project"));
  }

  /** Creates a project webhook for merge request, note, and push events, signed with `secret` (`X-Gitlab-Token`). */
  async createHook(projectId: number, url: string, secret: string): Promise<{ id: number }> {
    return parse(
      hookSchema,
      await this.request(`/projects/${projectRef(projectId)}/hooks`, {
        method: "POST",
        body: {
          url,
          token: secret,
          merge_requests_events: true,
          note_events: true,
          push_events: true,
          enable_ssl_verification: url.startsWith("https:"),
        },
      }),
      "hook",
    );
  }

  /** Deletes a project webhook; a hook that is already gone counts as deleted. */
  async deleteHook(projectId: number, hookId: number): Promise<void> {
    try {
      await this.send(`/projects/${projectRef(projectId)}/hooks/${hookId}`, { method: "DELETE" });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /** One merge request discussion (webhooks use it to find a note's thread root). */
  async getDiscussion(repo: string | number, iid: number, discussionId: string): Promise<Discussion> {
    return parse(
      discussionSchema,
      await this.request(`/projects/${projectRef(repo)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`),
      "discussion",
    );
  }

  /** A user's effective access level on a project (inherited memberships included), or null when not a member. */
  async memberAccessLevel(repo: string | number, userId: number): Promise<number | null> {
    try {
      return parse(memberSchema, await this.request(`/projects/${projectRef(repo)}/members/all/${userId}`), "member").access_level;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

export class GitLabHost implements GitHost {
  readonly provider = "gitlab";
  private readonly http: ScmHttp;

  constructor(private readonly config: GitLabHostConfig) {
    this.http = new ScmHttp({
      provider: "gitlab",
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.sleep ? { sleep: config.sleep } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(config.maxWaitMs !== undefined ? { maxWaitMs: config.maxWaitMs } : {}),
      log: config.log ?? rootLog.child({ component: "gitlab" }),
    });
  }

  /** API access for a connection that is not stored yet (validating a token before saving it). */
  apiFor(connection: GitLabConnection): GitLabApi {
    return new GitLabApi(this.http, connection);
  }

  async api(installationId: number): Promise<GitLabApi> {
    return this.apiFor(await this.config.credentials(installationId));
  }

  /** The token's identity and scopes; `permissions` maps each granted scope to `write`. */
  async getInstallation(installationId: number): Promise<RemoteInstallation> {
    const api = await this.api(installationId);
    const [token, me] = await Promise.all([api.tokenSelf(), api.currentUser()]);
    return {
      id: installationId,
      accountLogin: me.username,
      accountType: me.bot ? "Bot" : "User",
      permissions: Object.fromEntries(token.scopes.map((s) => [s, "write"])),
      repositorySelection: "selected",
    };
  }

  async listInstallationRepos(installationId: number): Promise<RemoteRepo[]> {
    return (await this.api(installationId)).listProjects();
  }

  client(installationId: number): GitClient {
    return new GitLabClient(() => this.api(installationId));
  }
}

function toIssueComment(n: Note): IssueComment {
  return { id: n.id, body: n.body ?? "", author: n.author?.username ?? "" };
}

function toReviewComment(n: Note, root: Note | undefined): ReviewComment {
  const pos = root?.position ?? n.position;
  return {
    id: n.id,
    path: pos?.new_path ?? pos?.old_path ?? "",
    line: pos?.new_line ?? null,
    body: n.body ?? "",
    author: n.author?.username ?? "",
    inReplyTo: root && root.id !== n.id ? root.id : null,
  };
}

/** Diff notes (inline comments) are the threads GitHub calls review comments. */
const isDiffDiscussion = (d: Discussion) => d.notes.some((n) => n.type === "DiffNote");

export class GitLabClient implements GitClient {
  constructor(private readonly connect: () => Promise<GitLabApi>) {}

  private async mrPath(repo: string, iid: number) {
    return { api: await this.connect(), base: `/projects/${projectRef(repo)}/merge_requests/${iid}` };
  }

  async cloneUrl(repo: string) {
    const api = await this.connect();
    const url = new URL(`${api.webUrl}/${repo}.git`);
    // Access tokens authenticate git over HTTPS with any non-blank username.
    url.username = "oauth2";
    url.password = api.connection.token;
    return url.toString();
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const { api, base } = await this.mrPath(repo, number);
    const mr = parse(mrSchema, await api.request(base), "merge request");
    let baseSha = mr.diff_refs?.base_sha ?? null;
    const headSha = mr.diff_refs?.head_sha ?? mr.sha ?? null;
    if (!baseSha) {
      // A merge request whose diff GitLab has not computed yet has no diff_refs; its versions may already exist.
      const versions = (await api.paginate(`${base}/versions`)).map((v) => parse(versionSchema, v, "merge request version"));
      baseSha = versions[0]?.base_commit_sha ?? null;
    }
    if (!baseSha || !headSha) throw new ScmHttpError("gitlab", 409, `GitLab merge request !${number} has no diff yet`, 15_000);
    return {
      number: mr.iid,
      title: mr.title ?? "",
      body: mr.description ?? "",
      author: mr.author?.username ?? "",
      headSha,
      baseSha,
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      state: mr.state === "opened" ? "open" : "closed",
      draft: Boolean(mr.draft ?? mr.work_in_progress),
      merged: mr.state === "merged",
      ...(mr.web_url ? { url: mr.web_url } : {}),
      closedAt: mr.closed_at ?? null,
      mergedAt: mr.merged_at ?? null,
    };
  }

  private async diffs(api: GitLabApi, base: string): Promise<z.infer<typeof diffSchema>[]> {
    try {
      return (await api.paginate(`${base}/diffs`)).map((d) => parse(diffSchema, d, "merge request diff"));
    } catch (err) {
      // `/diffs` arrived in GitLab 15.7; older instances only have the (single-page) `/changes`.
      if (!isNotFound(err)) throw err;
      const res = parse(z.object({ changes: z.array(diffSchema).default([]) }), await api.request(`${base}/changes`), "merge request changes");
      return res.changes;
    }
  }

  async listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]> {
    const { api, base } = await this.mrPath(repo, number);
    return (await this.diffs(api, base)).map(toFile);
  }

  async getFileContent(repo: string, path: string, ref: string): Promise<string | null> {
    const api = await this.connect();
    try {
      const res = await api.send(`/projects/${projectRef(repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`, { accept: "*/*" });
      return await res.text();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listTree(repo: string, ref: string): Promise<string[]> {
    const api = await this.connect();
    const rows = await api.paginate(`/projects/${projectRef(repo)}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&pagination=keyset`);
    return rows.map((r) => parse(treeEntry, r, "tree entry")).filter((t) => t.type === "blob").map((t) => t.path);
  }

  async compareCommits(repo: string, base: string, head: string): Promise<ChangedFile[]> {
    const api = await this.connect();
    const res = parse(
      compareSchema,
      await api.request(`/projects/${projectRef(repo)}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}&straight=false`),
      "compare",
    );
    return res.diffs.map((d) => {
      const f = toFile(d);
      return { path: f.path, ...(f.previousPath ? { previousPath: f.previousPath } : {}), status: f.status };
    });
  }

  private async notes(repo: string, number: number): Promise<Note[]> {
    const { api, base } = await this.mrPath(repo, number);
    return (await api.paginate(`${base}/notes?sort=asc&order_by=created_at`)).map((n) => parse(noteSchema, n, "note"));
  }

  async listIssueComments(repo: string, number: number): Promise<IssueComment[]> {
    return (await this.notes(repo, number)).filter((n) => !n.system && n.type !== "DiffNote").map(toIssueComment);
  }

  async createIssueComment(repo: string, number: number, body: string): Promise<IssueComment> {
    const { api, base } = await this.mrPath(repo, number);
    return toIssueComment(parse(noteSchema, await api.request(`${base}/notes`, { method: "POST", body: { body } }), "note"));
  }

  async updateIssueComment(repo: string, number: number, commentId: number, body: string): Promise<IssueComment> {
    const { api, base } = await this.mrPath(repo, number);
    return toIssueComment(parse(noteSchema, await api.request(`${base}/notes/${commentId}`, { method: "PUT", body: { body } }), "note"));
  }

  private async discussions(api: GitLabApi, base: string): Promise<Discussion[]> {
    return (await api.paginate(`${base}/discussions`)).map((d) => parse(discussionSchema, d, "discussion"));
  }

  async listReviewComments(repo: string, number: number): Promise<ReviewComment[]> {
    const { api, base } = await this.mrPath(repo, number);
    const out: ReviewComment[] = [];
    for (const d of await this.discussions(api, base)) {
      if (!isDiffDiscussion(d)) continue;
      const notes = d.notes.filter((n) => !n.system);
      const root = notes[0];
      for (const n of notes) out.push(toReviewComment(n, root));
    }
    return out;
  }

  async replyToReviewComment(repo: string, number: number, commentId: number, body: string): Promise<ReviewComment> {
    const { api, base } = await this.mrPath(repo, number);
    const thread = (await this.discussions(api, base)).find((d) => d.notes.some((n) => n.id === commentId));
    if (!thread) throw new ScmHttpError("gitlab", 404, `GitLab note ${commentId} is not in a discussion on !${number}`);
    const note = parse(
      noteSchema,
      await api.request(`${base}/discussions/${encodeURIComponent(thread.id)}/notes`, { method: "POST", body: { body } }),
      "note",
    );
    return toReviewComment(note, thread.notes[0]);
  }

  async updateReviewComment(repo: string, number: number, commentId: number, body: string): Promise<ReviewComment> {
    const { api, base } = await this.mrPath(repo, number);
    const note = parse(noteSchema, await api.request(`${base}/notes/${commentId}`, { method: "PUT", body: { body } }), "note");
    return toReviewComment(note, undefined);
  }

  async listReviewCommentReactions(repo: string, number: number, commentId: number): Promise<Reaction[]> {
    const { api, base } = await this.mrPath(repo, number);
    return (await api.paginate(`${base}/notes/${commentId}/award_emoji`)).map((raw) => {
      const a = parse(awardSchema, raw, "award emoji");
      return { id: a.id, content: AWARD_TO_REACTION[a.name] ?? a.name, user: a.user?.username ?? "" };
    });
  }

  async listPullRequestCommits(repo: string, number: number): Promise<PullRequestCommit[]> {
    const { api, base } = await this.mrPath(repo, number);
    // GitLab lists merge request commits newest first.
    return (await api.paginate(`${base}/commits`))
      .map((raw) => {
        const c = parse(commitSchema, raw, "commit");
        return { sha: c.id, message: c.message ?? "", author: c.author_name ?? "", committedAt: c.committed_date ?? null };
      })
      .reverse();
  }

  /** Approvals as `APPROVED` reviews; empty when the approvals API is unavailable to the token. */
  async listReviews(repo: string, number: number): Promise<PullRequestReview[]> {
    const { api, base } = await this.mrPath(repo, number);
    try {
      const res = parse(approvalsSchema, await api.request(`${base}/approvals`), "approvals");
      return res.approved_by.map((a, i) => ({
        id: a.user?.id ?? i + 1,
        author: a.user?.username ?? "",
        state: "APPROVED",
        body: "",
        commitId: null,
        submittedAt: null,
      }));
    } catch (err) {
      if (err instanceof ScmHttpError && (err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  }

  /** Pipelines for the commit as check runs; empty when the token may not read pipelines. */
  async listCheckRuns(repo: string, ref: string): Promise<CheckRun[]> {
    const api = await this.connect();
    try {
      const rows = await api.paginate(`/projects/${projectRef(repo)}/pipelines?sha=${encodeURIComponent(ref)}&order_by=id&sort=desc`);
      return rows.map((raw) => {
        const p = parse(pipelineSchema, raw, "pipeline");
        return { name: `pipeline #${p.id}${p.source ? ` (${p.source})` : ""}`, ...pipelineCheck(p.status) };
      });
    } catch (err) {
      if (err instanceof ScmHttpError && err.retryAfterMs === undefined && (err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  }

  /**
   * Posts each inline comment as a diff discussion positioned on the merge request version whose head is `commitId`
   * (`base_sha`/`start_sha`/`head_sha` from `GET …/versions`, per GitLab's discussions API). A context line carries
   * both `old_line` and `new_line`, an added line only `new_line`. A comment GitLab rejects with 400 (its line is not
   * in the diff any more) is posted as a plain discussion naming the location, so one bad position never blocks the
   * rest of the review.
   */
  async createReview(
    repo: string,
    number: number,
    review: { commitId: string; body: string; comments: NewInlineComment[] },
  ): Promise<{ id: number; comments: ReviewComment[] }> {
    const { api, base } = await this.mrPath(repo, number);
    const versions = (await api.paginate(`${base}/versions`)).map((v) => parse(versionSchema, v, "merge request version"));
    const version = versions.find((v) => v.head_commit_sha === review.commitId);
    let refs: { base_sha: string; start_sha: string; head_sha: string } | undefined = version
      ? { base_sha: version.base_commit_sha, start_sha: version.start_commit_sha, head_sha: version.head_commit_sha }
      : undefined;
    if (!refs) {
      const mr = parse(mrSchema, await api.request(base), "merge request");
      const r = mr.diff_refs;
      if (r?.base_sha && r.start_sha && r.head_sha === review.commitId) refs = { base_sha: r.base_sha, start_sha: r.start_sha, head_sha: r.head_sha };
    }
    if (!refs) throw new ScmHttpError("gitlab", 409, `GitLab merge request !${number} has no diff version for ${review.commitId.slice(0, 7)}`);

    const files = new Map((await this.diffs(api, base)).map((d) => [d.new_path, d]));
    const posted: ReviewComment[] = [];
    if (review.body.trim()) await api.request(`${base}/notes`, { method: "POST", body: { body: review.body } });
    for (const c of review.comments) {
      const file = files.get(c.path);
      const parsed = file ? parsePatch(c.path, "modified", file.diff ?? undefined) : undefined;
      const line = parsed?.lines.find((l) => l.newLine === c.line && l.kind !== "del");
      const positionBody = {
        position_type: "text",
        base_sha: refs.base_sha,
        start_sha: refs.start_sha,
        head_sha: refs.head_sha,
        old_path: file?.old_path ?? c.path,
        new_path: c.path,
        new_line: c.line,
        ...(line?.kind === "ctx" && line.oldLine !== undefined ? { old_line: line.oldLine } : {}),
      };
      let discussion: Discussion;
      try {
        discussion = parse(
          discussionSchema,
          await api.request(`${base}/discussions`, { method: "POST", body: { body: c.body, position: positionBody } }),
          "discussion",
        );
      } catch (err) {
        if (!(err instanceof ScmHttpError) || err.status !== 400) throw err;
        discussion = parse(
          discussionSchema,
          await api.request(`${base}/discussions`, { method: "POST", body: { body: `**\`${c.path}:${c.line}\`**\n\n${c.body}` } }),
          "discussion",
        );
      }
      const note = discussion.notes[0];
      if (note) posted.push({ ...toReviewComment(note, note), path: c.path, line: c.line, inReplyTo: null });
    }
    return { id: posted[0]?.id ?? 0, comments: posted };
  }
}

function toFile(d: z.infer<typeof diffSchema>): PullRequestFile {
  const status: PullRequestFile["status"] = d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified";
  const patch = d.too_large || d.collapsed || !d.diff ? undefined : d.diff;
  return {
    path: d.deleted_file ? d.old_path : d.new_path,
    ...(d.renamed_file ? { previousPath: d.old_path } : {}),
    status,
    ...(patch !== undefined ? { patch } : {}),
  };
}

