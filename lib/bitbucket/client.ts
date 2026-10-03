/**
 * Bitbucket Cloud behind the provider-neutral {@link GitHost} / {@link GitClient} (R3.6).
 *
 * An org connects a workspace with a workspace (or repository) access token, or with an app password / API token and
 * its username; the secret is stored encrypted in `scm_credentials` and the credential is the host's "installation"
 * (`installations.external_id` is the credential id). Repositories are addressed as `workspace/repo_slug`; their
 * numeric id is derived from the repository UUID ({@link bitbucketRepoId}). Inline comments carry
 * `inline: { path, to }` (new-file line); replies nest under a `parent`. Bitbucket renders no HTML, so the
 * `<!-- openreview:… -->` markers OpenReview relies on are written as invisible markdown reference definitions and read
 * back as markers ({@link toBitbucketMarkdown}, {@link fromBitbucketMarkdown}).
 */
import { z } from "zod";
import { log as rootLog, type Logger } from "@/lib/log";
import { splitUnifiedDiff } from "@/lib/scm/diff";
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

/** A resolved Bitbucket connection. `username` is set for app passwords / API tokens (HTTP basic auth). */
export interface BitbucketConnection {
  apiUrl: string;
  workspace: string;
  token: string;
  username?: string | null;
}

export interface BitbucketHostConfig {
  credentials: (installationId: number) => Promise<BitbucketConnection>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: Logger;
  maxWaitMs?: number;
}

/** Scopes OpenReview needs: read repositories (clone, files), write pull request comments, manage webhooks. */
export const BITBUCKET_REQUIRED_SCOPES = ["repository", "pullrequest:write", "webhook"] as const;

/** Webhook events OpenReview subscribes a repository to. */
export const BITBUCKET_HOOK_EVENTS = [
  "pullrequest:created",
  "pullrequest:updated",
  "pullrequest:fulfilled",
  "pullrequest:rejected",
  "pullrequest:comment_created",
  "repo:push",
] as const;

/**
 * Scopes a granted scope implies (Bitbucket scopes nest: `pullrequest:write` ⊃ `pullrequest` ⊃ `repository`), so a
 * token reporting only the broader scope still satisfies the narrower requirement.
 */
const IMPLIES: Record<string, string[]> = {
  "repository:admin": ["repository:write", "repository"],
  "repository:write": ["repository"],
  "pullrequest:write": ["pullrequest", "repository:write", "repository"],
  pullrequest: ["repository"],
  "webhook:write": ["webhook"],
};

/** The required scopes `granted` does not cover (implied scopes included). */
export function missingBitbucketScopes(granted: string[]): string[] {
  const all = new Set(granted.flatMap((s) => [s, ...(IMPLIES[s] ?? [])]));
  return BITBUCKET_REQUIRED_SCOPES.filter((s) => !all.has(s));
}

/** The web origin for an API URL (`https://api.bitbucket.org/2.0` → `https://bitbucket.org`). */
export function bitbucketWebUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  const host = u.hostname.startsWith("api.") ? u.hostname.slice(4) : u.hostname;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
}

/** UUIDs without braces, lower case (`{ABC-…}` and `abc-…` name the same object). */
export const normalizeUuid = (uuid: string) => uuid.replace(/[{}]/g, "").toLowerCase();

/** A stable numeric id for a repository UUID (`{xxxxxxxx-…}`): its first 52 bits. */
export function bitbucketRepoId(uuid: string): number {
  const hex = uuid.replace(/[{}-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{13,}$/.test(hex)) throw new Error(`not a Bitbucket UUID: ${uuid}`);
  return Number.parseInt(hex.slice(0, 13), 16);
}

/** A stable positive 31-bit number for an account UUID (participants have no numeric id). */
function accountNumber(uuid: string | null | undefined): number {
  const hex = (uuid ?? "").replace(/[{}-]/g, "");
  return /^[0-9a-f]{8}/i.test(hex) ? Number.parseInt(hex.slice(0, 8), 16) & 0x7fffffff : 0;
}

const HTML_MARKER = /^<!-- (openreview:[A-Za-z0-9:=_.-]+) -->$/gm;
const REF_MARKER = /^\[\/\/\]: # \((openreview:[A-Za-z0-9:=_.-]+)\)$/gm;

/**
 * Body as sent to Bitbucket: marker lines become reference definitions (invisible in rendered markdown). Any
 * reference-style marker already in the text (e.g. quoted from a comment) is escaped first so it can never be read
 * back as one of ours.
 */
export function toBitbucketMarkdown(body: string): string {
  return body.replace(REF_MARKER, (m) => `\\${m}`).replace(HTML_MARKER, "[//]: # ($1)");
}

/** Body as read from Bitbucket, with OpenReview's markers in their usual `<!-- … -->` form. */
export function fromBitbucketMarkdown(raw: string): string {
  return raw.replace(REF_MARKER, "<!-- $1 -->");
}

// ---- response schemas ----

const account = z
  .object({ uuid: z.string().nullish(), nickname: z.string().nullish(), display_name: z.string().nullish(), username: z.string().nullish() })
  .nullish();
const login = (a: z.infer<typeof account>) => a?.nickname ?? a?.username ?? a?.display_name ?? "";

export const bitbucketRepoSchema = z.object({
  uuid: z.string(),
  full_name: z.string(),
  is_private: z.boolean().nullish(),
  mainbranch: z.object({ name: z.string() }).nullish(),
});

const prSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  author: account,
  state: z.string(),
  draft: z.boolean().nullish(),
  source: z.object({ branch: z.object({ name: z.string() }), commit: z.object({ hash: z.string() }).nullish() }),
  destination: z.object({ branch: z.object({ name: z.string() }), commit: z.object({ hash: z.string() }).nullish() }),
  links: z.object({ html: z.object({ href: z.string() }).nullish() }).nullish(),
  updated_on: z.string().nullish(),
  closed_on: z.string().nullish(),
  participants: z
    .array(z.object({ user: account, approved: z.boolean().nullish(), state: z.string().nullish(), participated_on: z.string().nullish() }))
    .default([]),
});

const commentSchema = z.object({
  id: z.number(),
  content: z.object({ raw: z.string().nullish() }).nullish(),
  user: account,
  deleted: z.boolean().nullish(),
  inline: z.object({ path: z.string(), to: z.number().nullish(), from: z.number().nullish() }).nullish(),
  parent: z.object({ id: z.number() }).nullish(),
});
type Comment = z.infer<typeof commentSchema>;

const diffstatSchema = z.object({
  status: z.string(),
  old: z.object({ path: z.string() }).nullish(),
  new: z.object({ path: z.string() }).nullish(),
});
const commitSchema = z.object({
  hash: z.string(),
  message: z.string().nullish(),
  date: z.string().nullish(),
  author: z.object({ raw: z.string().nullish(), user: account }).nullish(),
});
const statusSchema = z.object({ key: z.string().nullish(), name: z.string().nullish(), state: z.string() });
const srcEntry = z.object({ path: z.string(), type: z.string() });
const hookSchema = z.object({ uuid: z.string() });
export const bitbucketWorkspaceSchema = z.object({ uuid: z.string(), slug: z.string(), name: z.string().nullish() });

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`Unexpected Bitbucket response for ${what}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
}

export function toBitbucketRemoteRepo(r: z.infer<typeof bitbucketRepoSchema>): RemoteRepo {
  return { id: bitbucketRepoId(r.uuid), fullName: r.full_name, defaultBranch: r.mainbranch?.name ?? "main", private: r.is_private !== false };
}

/** A Bitbucket commit status state as a check run status and conclusion. */
export function statusCheck(state: string): Pick<CheckRun, "status" | "conclusion"> {
  switch (state) {
    case "SUCCESSFUL":
      return { status: "completed", conclusion: "success" };
    case "FAILED":
      return { status: "completed", conclusion: "failure" };
    case "STOPPED":
      return { status: "completed", conclusion: "cancelled" };
    default:
      return { status: "in_progress", conclusion: null };
  }
}

const DIFFSTAT_STATUS: Record<string, PullRequestFile["status"]> = { added: "added", removed: "removed", modified: "modified", renamed: "renamed" };

/** Splits `workspace/repo_slug` into URL-safe parts. */
function repoPath(repo: string): string {
  const [workspace, slug, ...rest] = repo.split("/");
  if (!workspace || !slug || rest.length) throw new Error(`not a Bitbucket repository name: ${repo}`);
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

/** REST access to one Bitbucket connection (API 2.0), with `next`-link pagination. */
export class BitbucketApi {
  readonly apiUrl: string;
  readonly webUrl: string;

  constructor(
    private readonly http: ScmHttp,
    readonly connection: BitbucketConnection,
  ) {
    this.apiUrl = connection.apiUrl.replace(/\/+$/, "");
    this.webUrl = bitbucketWebUrl(this.apiUrl);
  }

  private headers(): Record<string, string> {
    const c = this.connection;
    return {
      authorization: c.username ? `Basic ${Buffer.from(`${c.username}:${c.token}`).toString("base64")}` : `Bearer ${c.token}`,
    };
  }

  async send(path: string, init: { method?: string; body?: unknown; accept?: string; idempotent?: boolean; follow?: boolean } = {}) {
    const { follow, ...rest } = init;
    return this.http.send(`${this.apiUrl}${path}`, { ...rest, headers: this.headers(), ...(follow ? { redirect: "follow" as const } : {}) });
  }

  async request<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotent?: boolean } = {}): Promise<T> {
    return this.http.json<T>(`${this.apiUrl}${path}`, { ...init, headers: this.headers() });
  }

  /** Every `values` entry of a paginated endpoint, following `next` links on the API's own origin. */
  async paginate(path: string, pagelen = 100): Promise<unknown[]> {
    const out: unknown[] = [];
    const origin = new URL(this.apiUrl).origin;
    let url: string | null = `${this.apiUrl}${path}${path.includes("?") ? "&" : "?"}pagelen=${pagelen}`;
    for (let pages = 0; url && pages < 500; pages++) {
      const page: { values: unknown[]; next?: string | null } = parse(
        z.object({ values: z.array(z.unknown()).default([]), next: z.string().nullish() }),
        await this.http.json(url, { headers: this.headers() }),
        "page",
      );
      out.push(...page.values);
      url = page.next && new URL(page.next).origin === origin ? page.next : null;
    }
    return out;
  }

  // ---- connection management ----

  /** The workspace and the scopes the credential reports (`x-oauth-scopes`; empty when Bitbucket does not say). */
  async checkWorkspace(): Promise<{ workspace: z.infer<typeof bitbucketWorkspaceSchema>; scopes: string[] | null }> {
    const res = await this.send(`/workspaces/${encodeURIComponent(this.connection.workspace)}`);
    const header = res.headers.get("x-oauth-scopes");
    const scopes = header === null ? null : header.split(/[\s,]+/).filter(Boolean);
    return { workspace: parse(bitbucketWorkspaceSchema, await res.json(), "workspace"), scopes };
  }

  /** The account the credential acts as, or null when the credential may not read it. */
  async currentUser(): Promise<{ uuid: string; login: string } | null> {
    try {
      const me = parse(
        z.object({ uuid: z.string(), nickname: z.string().nullish(), display_name: z.string().nullish(), username: z.string().nullish() }),
        await this.request("/user"),
        "user",
      );
      return { uuid: me.uuid, login: me.nickname ?? me.username ?? me.display_name ?? "" };
    } catch (err) {
      if (err instanceof ScmHttpError && (err.status === 401 || err.status === 403)) return null;
      throw err;
    }
  }

  async listRepositories(): Promise<RemoteRepo[]> {
    const rows = await this.paginate(`/repositories/${encodeURIComponent(this.connection.workspace)}?sort=full_name`);
    return rows.map((r) => toBitbucketRemoteRepo(parse(bitbucketRepoSchema, r, "repository")));
  }

  async getRepository(fullName: string) {
    return parse(bitbucketRepoSchema, await this.request(repoPath(fullName)), "repository");
  }

  /** Creates a repository webhook for {@link BITBUCKET_HOOK_EVENTS}; Bitbucket signs deliveries with `secret`. */
  async createHook(fullName: string, url: string, secret: string): Promise<{ uuid: string }> {
    return parse(
      hookSchema,
      await this.request(`${repoPath(fullName)}/hooks`, {
        method: "POST",
        body: { description: "OpenReview", url, active: true, secret, events: [...BITBUCKET_HOOK_EVENTS] },
      }),
      "hook",
    );
  }

  async deleteHook(fullName: string, hookUuid: string): Promise<void> {
    try {
      await this.send(`${repoPath(fullName)}/hooks/${encodeURIComponent(`{${normalizeUuid(hookUuid)}}`)}`, { method: "DELETE" });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async getComment(fullName: string, prId: number, commentId: number): Promise<Comment> {
    return parse(commentSchema, await this.request(`${repoPath(fullName)}/pullrequests/${prId}/comments/${commentId}`), "comment");
  }

  /** Whether an account is a member of the credential's workspace (null when the credential may not tell). */
  async isWorkspaceMember(accountUuid: string): Promise<boolean | null> {
    try {
      await this.request(`/workspaces/${encodeURIComponent(this.connection.workspace)}/members/${encodeURIComponent(accountUuid)}`);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      if (err instanceof ScmHttpError && (err.status === 401 || err.status === 403)) return null;
      throw err;
    }
  }
}

export class BitbucketHost implements GitHost {
  readonly provider = "bitbucket";
  private readonly http: ScmHttp;

  constructor(private readonly config: BitbucketHostConfig) {
    this.http = new ScmHttp({
      provider: "bitbucket",
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.sleep ? { sleep: config.sleep } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(config.maxWaitMs !== undefined ? { maxWaitMs: config.maxWaitMs } : {}),
      log: config.log ?? rootLog.child({ component: "bitbucket" }),
    });
  }

  apiFor(connection: BitbucketConnection): BitbucketApi {
    return new BitbucketApi(this.http, connection);
  }

  async api(installationId: number): Promise<BitbucketApi> {
    return this.apiFor(await this.config.credentials(installationId));
  }

  async getInstallation(installationId: number): Promise<RemoteInstallation> {
    const api = await this.api(installationId);
    const { workspace, scopes } = await api.checkWorkspace();
    return {
      id: installationId,
      accountLogin: workspace.slug,
      accountType: "Workspace",
      ...(scopes ? { permissions: Object.fromEntries(scopes.map((s) => [s, "write"])) } : {}),
      repositorySelection: "selected",
    };
  }

  async listInstallationRepos(installationId: number): Promise<RemoteRepo[]> {
    return (await this.api(installationId)).listRepositories();
  }

  client(installationId: number): GitClient {
    return new BitbucketClient(() => this.api(installationId));
  }
}

function toIssueComment(c: Comment): IssueComment {
  return { id: c.id, body: fromBitbucketMarkdown(c.content?.raw ?? ""), author: login(c.user) };
}

/** Thread root of each comment (replies nest arbitrarily deep). */
function threadRoots(comments: Comment[]): Map<number, Comment> {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots = new Map<number, Comment>();
  for (const c of comments) {
    let root = c;
    for (let hops = 0; root.parent && hops < 100; hops++) {
      const up = byId.get(root.parent.id);
      if (!up) break;
      root = up;
    }
    roots.set(c.id, root);
  }
  return roots;
}

function toReviewComment(c: Comment, root: Comment): ReviewComment {
  const inline = c.inline ?? root.inline;
  return {
    id: c.id,
    path: inline?.path ?? "",
    line: inline?.to ?? null,
    body: fromBitbucketMarkdown(c.content?.raw ?? ""),
    author: login(c.user),
    inReplyTo: root.id !== c.id ? root.id : null,
  };
}

export class BitbucketClient implements GitClient {
  constructor(private readonly connect: () => Promise<BitbucketApi>) {}

  private async pr(repo: string, id: number) {
    return { api: await this.connect(), base: `${repoPath(repo)}/pullrequests/${id}` };
  }

  async cloneUrl(repo: string) {
    const api = await this.connect();
    const url = new URL(`${api.webUrl}/${repo}.git`);
    url.username = api.connection.username ?? "x-token-auth";
    url.password = api.connection.token;
    return url.toString();
  }

  /** The full 40-character sha of a (possibly abbreviated) commit hash. */
  private async fullSha(api: BitbucketApi, repo: string, hash: string): Promise<string> {
    if (/^[0-9a-f]{40}$/i.test(hash)) return hash;
    return parse(commitSchema, await api.request(`${repoPath(repo)}/commit/${encodeURIComponent(hash)}`), "commit").hash;
  }

  private async rawPr(repo: string, id: number) {
    const { api, base } = await this.pr(repo, id);
    return { api, base, pr: parse(prSchema, await api.request(base), "pull request") };
  }

  /**
   * The pull request with full shas: the head is the source commit; the base is the merge base of the source and
   * destination commits (Bitbucket's pull request diff is computed against it), or the destination commit when the
   * merge base is unavailable.
   */
  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const { api, pr } = await this.rawPr(repo, number);
    const head = pr.source.commit?.hash;
    const dest = pr.destination.commit?.hash;
    if (!head || !dest) throw new ScmHttpError("bitbucket", 409, `Bitbucket pull request #${number} has no commits yet`, 15_000);
    const headSha = await this.fullSha(api, repo, head);
    let baseSha: string;
    try {
      baseSha = parse(commitSchema, await api.request(`${repoPath(repo)}/merge-base/${encodeURIComponent(`${headSha}..${dest}`)}`), "merge base").hash;
    } catch (err) {
      if (!(err instanceof ScmHttpError) || err.retryAfterMs !== undefined) throw err;
      baseSha = await this.fullSha(api, repo, dest);
    }
    return {
      number: pr.id,
      title: pr.title ?? "",
      body: pr.description ?? "",
      author: login(pr.author),
      headSha,
      baseSha,
      baseRef: pr.destination.branch.name,
      headRef: pr.source.branch.name,
      state: pr.state === "OPEN" ? "open" : "closed",
      draft: Boolean(pr.draft),
      merged: pr.state === "MERGED",
      ...(pr.links?.html?.href ? { url: pr.links.html.href } : {}),
      closedAt: pr.state === "OPEN" ? null : (pr.closed_on ?? pr.updated_on ?? null),
      mergedAt: pr.state === "MERGED" ? (pr.closed_on ?? pr.updated_on ?? null) : null,
    };
  }

  /** Files from the diffstat joined with their hunks from the raw diff. */
  private async files(api: BitbucketApi, statPath: string, diffPath: string): Promise<PullRequestFile[]> {
    const [stats, diffRes] = await Promise.all([api.paginate(statPath, 500), api.send(diffPath, { accept: "text/plain", follow: true })]);
    const patches = new Map<string, string>();
    for (const f of splitUnifiedDiff(await diffRes.text())) {
      const key = f.newPath ?? f.oldPath;
      if (key && f.patch) patches.set(key, f.patch);
    }
    return stats.map((raw) => {
      const s = parse(diffstatSchema, raw, "diffstat");
      const status = DIFFSTAT_STATUS[s.status] ?? "modified";
      const path = s.new?.path ?? s.old?.path ?? "";
      const previousPath = status === "renamed" && s.old?.path && s.old.path !== path ? s.old.path : undefined;
      const patch = patches.get(path);
      return { path, ...(previousPath ? { previousPath } : {}), status, ...(patch ? { patch } : {}) };
    });
  }

  async listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]> {
    const { api, base } = await this.pr(repo, number);
    return this.files(api, `${base}/diffstat`, `${base}/diff`);
  }

  async getFileContent(repo: string, path: string, ref: string): Promise<string | null> {
    const api = await this.connect();
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    try {
      const res = await api.send(`${repoPath(repo)}/src/${encodeURIComponent(ref)}/${encoded}`, { accept: "*/*", follow: true });
      const text = await res.text();
      // A directory comes back as a JSON page of entries rather than file content.
      if ((res.headers.get("content-type") ?? "").includes("application/json")) {
        try {
          const page = JSON.parse(text) as { values?: unknown; pagelen?: unknown };
          if (Array.isArray(page.values) && typeof page.pagelen === "number" && srcEntry.safeParse(page.values[0]).success) return null;
        } catch {
          // Not JSON after all: it is file content.
        }
      }
      return text;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listTree(repo: string, ref: string): Promise<string[]> {
    const api = await this.connect();
    const rows = await api.paginate(`${repoPath(repo)}/src/${encodeURIComponent(ref)}/?max_depth=100`);
    return rows.map((r) => parse(srcEntry, r, "source entry")).filter((e) => e.type === "commit_file").map((e) => e.path);
  }

  /** Files changed from `base` to `head` (three-dot: against their merge base). Bitbucket's spec is `head..base`. */
  async compareCommits(repo: string, base: string, head: string): Promise<ChangedFile[]> {
    const api = await this.connect();
    const spec = encodeURIComponent(`${head}..${base}`);
    return (await api.paginate(`${repoPath(repo)}/diffstat/${spec}`, 500)).map((raw) => {
      const s = parse(diffstatSchema, raw, "diffstat");
      const status = DIFFSTAT_STATUS[s.status] ?? "modified";
      const path = s.new?.path ?? s.old?.path ?? "";
      const previousPath = status === "renamed" && s.old?.path && s.old.path !== path ? s.old.path : undefined;
      return { path, ...(previousPath ? { previousPath } : {}), status };
    });
  }

  private async comments(repo: string, number: number): Promise<Comment[]> {
    const { api, base } = await this.pr(repo, number);
    return (await api.paginate(`${base}/comments`)).map((c) => parse(commentSchema, c, "comment")).filter((c) => !c.deleted);
  }

  async listIssueComments(repo: string, number: number): Promise<IssueComment[]> {
    const all = await this.comments(repo, number);
    const roots = threadRoots(all);
    return all.filter((c) => !c.inline && !roots.get(c.id)?.inline).map(toIssueComment);
  }

  async createIssueComment(repo: string, number: number, body: string): Promise<IssueComment> {
    const { api, base } = await this.pr(repo, number);
    return toIssueComment(parse(commentSchema, await api.request(`${base}/comments`, { method: "POST", body: { content: { raw: toBitbucketMarkdown(body) } } }), "comment"));
  }

  async updateIssueComment(repo: string, number: number, commentId: number, body: string): Promise<IssueComment> {
    const { api, base } = await this.pr(repo, number);
    return toIssueComment(
      parse(commentSchema, await api.request(`${base}/comments/${commentId}`, { method: "PUT", body: { content: { raw: toBitbucketMarkdown(body) } } }), "comment"),
    );
  }

  async listReviewComments(repo: string, number: number): Promise<ReviewComment[]> {
    const all = await this.comments(repo, number);
    const roots = threadRoots(all);
    const out: ReviewComment[] = [];
    for (const c of all) {
      const root = roots.get(c.id) ?? c;
      if (c.inline || root.inline) out.push(toReviewComment(c, root));
    }
    return out;
  }

  async replyToReviewComment(repo: string, number: number, commentId: number, body: string): Promise<ReviewComment> {
    const { api, base } = await this.pr(repo, number);
    const parent = await api.getComment(repo, number, commentId);
    const reply = parse(
      commentSchema,
      await api.request(`${base}/comments`, { method: "POST", body: { content: { raw: toBitbucketMarkdown(body) }, parent: { id: commentId } } }),
      "comment",
    );
    return toReviewComment(reply, parent);
  }

  async updateReviewComment(repo: string, number: number, commentId: number, body: string): Promise<ReviewComment> {
    const { api, base } = await this.pr(repo, number);
    const c = parse(commentSchema, await api.request(`${base}/comments/${commentId}`, { method: "PUT", body: { content: { raw: toBitbucketMarkdown(body) } } }), "comment");
    return toReviewComment(c, c);
  }

  /** Bitbucket has no reactions on comments. */
  async listReviewCommentReactions(): Promise<Reaction[]> {
    return [];
  }

  async listPullRequestCommits(repo: string, number: number): Promise<PullRequestCommit[]> {
    const { api, base } = await this.pr(repo, number);
    // Bitbucket lists pull request commits newest first.
    return (await api.paginate(`${base}/commits`, 50))
      .map((raw) => {
        const c = parse(commitSchema, raw, "commit");
        return { sha: c.hash, message: c.message ?? "", author: c.author?.user ? login(c.author.user) : (c.author?.raw ?? ""), committedAt: c.date ?? null };
      })
      .reverse();
  }

  /** Participants who approved or requested changes, as reviews. */
  async listReviews(repo: string, number: number): Promise<PullRequestReview[]> {
    const { pr } = await this.rawPr(repo, number);
    return pr.participants
      .filter((p) => p.approved || p.state === "approved" || p.state === "changes_requested")
      .map((p) => ({
        id: accountNumber(p.user?.uuid),
        author: login(p.user),
        state: p.state === "changes_requested" ? "CHANGES_REQUESTED" : "APPROVED",
        body: "",
        commitId: null,
        submittedAt: p.participated_on ?? null,
      }));
  }

  /** Commit statuses (CI builds) as check runs; empty when the credential may not read them. */
  async listCheckRuns(repo: string, ref: string): Promise<CheckRun[]> {
    const api = await this.connect();
    try {
      return (await api.paginate(`${repoPath(repo)}/commit/${encodeURIComponent(ref)}/statuses`)).map((raw) => {
        const s = parse(statusSchema, raw, "commit status");
        return { name: s.name ?? s.key ?? "build", ...statusCheck(s.state) };
      });
    } catch (err) {
      if (err instanceof ScmHttpError && err.retryAfterMs === undefined && (err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  }

  /**
   * Posts each inline comment with `inline: { path, to }` (`to` is the new-file line). Bitbucket has no review
   * object, so the review id is the first comment's. A comment Bitbucket rejects with 400 (its line left the diff) is
   * posted as a general comment naming the location.
   */
  async createReview(
    repo: string,
    number: number,
    review: { commitId: string; body: string; comments: NewInlineComment[] },
  ): Promise<{ id: number; comments: ReviewComment[] }> {
    const { api, base } = await this.pr(repo, number);
    if (review.body.trim()) await api.request(`${base}/comments`, { method: "POST", body: { content: { raw: toBitbucketMarkdown(review.body) } } });
    const posted: ReviewComment[] = [];
    for (const c of review.comments) {
      let created: Comment;
      try {
        created = parse(
          commentSchema,
          await api.request(`${base}/comments`, { method: "POST", body: { content: { raw: toBitbucketMarkdown(c.body) }, inline: { path: c.path, to: c.line } } }),
          "comment",
        );
      } catch (err) {
        if (!(err instanceof ScmHttpError) || err.status !== 400) throw err;
        created = parse(
          commentSchema,
          await api.request(`${base}/comments`, { method: "POST", body: { content: { raw: toBitbucketMarkdown(`**\`${c.path}:${c.line}\`**\n\n${c.body}`) } } }),
          "comment",
        );
      }
      posted.push({ ...toReviewComment(created, created), path: c.path, line: c.line, inReplyTo: null });
    }
    return { id: posted[0]?.id ?? 0, comments: posted };
  }
}
