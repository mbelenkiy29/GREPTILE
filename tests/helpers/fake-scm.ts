/**
 * In-memory GitLab and Bitbucket Cloud REST APIs behind an injected `fetch` (R3.6 tests): every request is recorded,
 * and comments, discussions, and hooks are stateful so the real clients run end to end without the network.
 */
import { fakeFetch, jsonResponse, type RecordedRequest } from "./fake-fetch";

export interface ScmWorld {
  repo: string;
  defaultBranch: string;
  pr: { number: number; title: string; body: string; author: string; base: string; head: string; sourceBranch: string; targetBranch: string; draft?: boolean };
  files: { path: string; previousPath?: string; status: "added" | "modified" | "removed" | "renamed"; patch: string }[];
  contentAt: (ref: string, path: string) => string | null;
  treeAt: (ref: string) => string[];
  compareAt?: (base: string, head: string) => { path: string; status: "added" | "modified" | "removed" }[];
  /** Oldest first. */
  commits: { sha: string; message: string; author: string; date: string }[];
  approvals: string[];
  checks: { name: string; ok: boolean }[];
}

const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
const notFound = () => jsonResponse({ message: "404 Not Found" }, 404);

function segments(url: string, prefix: string): { parts: string[]; query: URLSearchParams } {
  const u = new URL(url);
  const rest = u.pathname.slice(u.pathname.indexOf(prefix) + prefix.length);
  return { parts: rest.split("/").filter(Boolean).map(decodeURIComponent), query: u.searchParams };
}

// ---------------------------------------------------------------------------------------------------------------
// GitLab

interface GlNote {
  id: number;
  body: string;
  author: { id: number; username: string };
  system: boolean;
  type: "DiffNote" | "DiscussionNote" | null;
  position: Record<string, unknown> | null;
  discussionId: string;
  individual: boolean;
}

export class FakeGitLab {
  readonly baseUrl: string;
  readonly token: string;
  scopes = ["api", "read_repository"];
  active = true;
  expiresAt: string | null = "2027-01-31";
  botUser = { id: 900, username: "project_42_bot", bot: true };
  projects: { id: number; path: string; defaultBranch: string; visibility: string }[] = [];
  hooks: { id: number; projectId: number; url: string; token: string; events: Record<string, unknown> }[] = [];
  deletedHooks: number[] = [];
  notes: GlNote[] = [];
  awards = new Map<number, { id: number; name: string; user: { username: string } }[]>();
  members = new Map<number, number>();
  world?: ScmWorld & { projectId: number };
  /** Reject positioned discussions on these new lines with 400 (a line that left the diff). */
  rejectLines = new Set<number>();
  private nextId = 5000;
  readonly http: ReturnType<typeof fakeFetch>;

  constructor(opts: { baseUrl?: string; token?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? "https://gitlab.example.com";
    this.token = opts.token ?? ["glpat", "test", "token"].join("-");
    this.http = fakeFetch((req) => this.handle(req));
  }

  get fetch() {
    return this.http.fetch;
  }

  get requests(): RecordedRequest[] {
    return this.http.requests;
  }

  seed(world: ScmWorld, projectId = 42) {
    this.world = { ...world, projectId };
    if (!this.projects.some((p) => p.id === projectId)) this.projects.push({ id: projectId, path: world.repo, defaultBranch: world.defaultBranch, visibility: "private" });
  }

  /** A note written by someone else (a teammate) on the MR, optionally replying in an existing discussion. */
  addNote(n: { body: string; username: string; userId?: number; type?: GlNote["type"]; position?: Record<string, unknown> | null; discussionId?: string }): GlNote {
    const id = this.nextId++;
    const note: GlNote = {
      id,
      body: n.body,
      author: { id: n.userId ?? 77, username: n.username },
      system: false,
      type: n.type ?? null,
      position: n.position ?? null,
      discussionId: n.discussionId ?? `d${id}`,
      individual: !n.discussionId && !n.type,
    };
    this.notes.push(note);
    return note;
  }

  discussionOf(noteId: number) {
    return this.notes.find((n) => n.id === noteId)?.discussionId;
  }

  private project(ref: string) {
    return this.projects.find((p) => String(p.id) === ref || p.path === ref);
  }

  private noteJson(n: GlNote) {
    return { id: n.id, body: n.body, author: n.author, system: n.system, type: n.type, position: n.position };
  }

  private discussions() {
    const order: string[] = [];
    for (const n of this.notes) if (!order.includes(n.discussionId)) order.push(n.discussionId);
    return order.map((id) => {
      const notes = this.notes.filter((n) => n.discussionId === id);
      return { id, individual_note: notes.length === 1 && notes[0]!.individual, notes: notes.map((n) => this.noteJson(n)) };
    });
  }

  private mrJson(w: ScmWorld) {
    return {
      iid: w.pr.number,
      title: w.pr.title,
      description: w.pr.body,
      author: { id: 1, username: w.pr.author },
      sha: w.pr.head,
      diff_refs: { base_sha: w.pr.base, head_sha: w.pr.head, start_sha: w.pr.base },
      source_branch: w.pr.sourceBranch,
      target_branch: w.pr.targetBranch,
      state: "opened",
      draft: Boolean(w.pr.draft),
      web_url: `${this.baseUrl}/${w.repo}/-/merge_requests/${w.pr.number}`,
      merged_at: null,
      closed_at: null,
    };
  }

  private handle(req: RecordedRequest): Response {
    if (req.headers["private-token"] !== this.token) return jsonResponse({ message: "401 Unauthorized" }, 401);
    const { parts, query } = segments(req.url, "/api/v4");
    const m = req.method;
    const [head, ...rest] = parts;
    if (head === "personal_access_tokens" && rest[0] === "self") {
      return jsonResponse({ id: 31, name: "openreview", scopes: this.scopes, active: this.active, revoked: false, expires_at: this.expiresAt, user_id: this.botUser.id });
    }
    if (head === "user") return jsonResponse(this.botUser);
    if (head !== "projects") return notFound();
    if (rest.length === 0) {
      return jsonResponse(this.projects.map((p) => ({ id: p.id, path_with_namespace: p.path, default_branch: p.defaultBranch, visibility: p.visibility, archived: false })));
    }
    const project = this.project(rest[0]!);
    if (!project) return notFound();
    const sub = rest.slice(1);
    if (sub.length === 0) return jsonResponse({ id: project.id, path_with_namespace: project.path, default_branch: project.defaultBranch, visibility: project.visibility, archived: false });
    if (sub[0] === "hooks") {
      if (m === "POST") {
        const body = req.body as { url: string; token: string };
        const hook = { id: this.nextId++, projectId: project.id, url: body.url, token: body.token, events: req.body as Record<string, unknown> };
        this.hooks.push(hook);
        return jsonResponse({ id: hook.id }, 201);
      }
      if (m === "DELETE") {
        const id = Number(sub[1]);
        const before = this.hooks.length;
        this.hooks = this.hooks.filter((h) => h.id !== id);
        if (this.hooks.length === before) return notFound();
        this.deletedHooks.push(id);
        return new Response(null, { status: 204 });
      }
    }
    if (sub[0] === "members" && sub[1] === "all") {
      const level = this.members.get(Number(sub[2]));
      return level === undefined ? notFound() : jsonResponse({ access_level: level });
    }
    const w = this.world;
    if (!w || w.projectId !== project.id) return notFound();
    if (sub[0] === "repository") {
      if (sub[1] === "files" && sub[3] === "raw") {
        const content = w.contentAt(query.get("ref") ?? "", sub[2]!);
        return content === null ? notFound() : text(content);
      }
      if (sub[1] === "tree") return jsonResponse(w.treeAt(query.get("ref") ?? "").map((path) => ({ path, type: "blob" })));
      if (sub[1] === "compare") {
        const changed = w.compareAt?.(query.get("from") ?? "", query.get("to") ?? "") ?? [];
        return jsonResponse({ diffs: changed.map((c) => ({ old_path: c.path, new_path: c.path, diff: "", new_file: c.status === "added", deleted_file: c.status === "removed", renamed_file: false })) });
      }
    }
    if (sub[0] === "pipelines") {
      if (query.get("sha") !== w.pr.head) return jsonResponse([]);
      return jsonResponse(w.checks.map((c, i) => ({ id: 700 + i, status: c.ok ? "success" : "failed", source: "push" })));
    }
    if (sub[0] !== "merge_requests" || Number(sub[1]) !== w.pr.number) return notFound();
    const mr = sub.slice(2);
    if (mr.length === 0) return jsonResponse(this.mrJson(w));
    switch (mr[0]) {
      case "versions":
        return jsonResponse([{ id: 1, head_commit_sha: w.pr.head, base_commit_sha: w.pr.base, start_commit_sha: w.pr.base }]);
      case "diffs":
        return jsonResponse(
          w.files.map((f) => ({
            old_path: f.previousPath ?? f.path,
            new_path: f.path,
            diff: f.patch,
            new_file: f.status === "added",
            deleted_file: f.status === "removed",
            renamed_file: f.status === "renamed",
          })),
        );
      case "commits":
        return jsonResponse([...w.commits].reverse().map((c) => ({ id: c.sha, message: c.message, author_name: c.author, committed_date: c.date })));
      case "approvals":
        return jsonResponse({ approved_by: w.approvals.map((u, i) => ({ user: { id: 300 + i, username: u } })) });
      case "notes": {
        if (mr.length === 1 && m === "GET") return jsonResponse(this.notes.map((n) => this.noteJson(n)));
        if (mr.length === 1 && m === "POST") {
          const n = this.addNote({ body: (req.body as { body: string }).body, username: this.botUser.username, userId: this.botUser.id });
          return jsonResponse(this.noteJson(n), 201);
        }
        const note = this.notes.find((n) => n.id === Number(mr[1]));
        if (!note) return notFound();
        if (mr[2] === "award_emoji") return jsonResponse(this.awards.get(note.id) ?? []);
        if (m === "PUT") {
          note.body = (req.body as { body: string }).body;
          return jsonResponse(this.noteJson(note));
        }
        return notFound();
      }
      case "discussions": {
        if (mr.length === 1 && m === "GET") return jsonResponse(this.discussions());
        if (mr.length === 1 && m === "POST") {
          const body = req.body as { body: string; position?: Record<string, unknown> };
          if (body.position && this.rejectLines.has(Number(body.position.new_line))) return jsonResponse({ message: "400 (Bad request) \"Note {:line_code=>[\"can't be blank\"]}\"" }, 400);
          const id = this.nextId++;
          const n: GlNote = {
            id,
            body: body.body,
            author: { id: this.botUser.id, username: this.botUser.username },
            system: false,
            type: body.position ? "DiffNote" : "DiscussionNote",
            position: body.position ?? null,
            discussionId: `disc${id}`,
            individual: false,
          };
          this.notes.push(n);
          return jsonResponse({ id: n.discussionId, individual_note: false, notes: [this.noteJson(n)] }, 201);
        }
        const discussion = this.discussions().find((d) => d.id === mr[1]);
        if (!discussion) return notFound();
        if (mr.length === 2) return jsonResponse(discussion);
        if (mr[2] === "notes" && m === "POST") {
          const root = this.notes.find((n) => n.discussionId === discussion.id)!;
          const id = this.nextId++;
          const n: GlNote = {
            id,
            body: (req.body as { body: string }).body,
            author: { id: this.botUser.id, username: this.botUser.username },
            system: false,
            type: root.type,
            position: root.position,
            discussionId: discussion.id,
            individual: false,
          };
          this.notes.push(n);
          return jsonResponse(this.noteJson(n), 201);
        }
        return notFound();
      }
      default:
        return notFound();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bitbucket

interface BbComment {
  id: number;
  raw: string;
  user: { uuid: string; nickname: string };
  inline: { path: string; to: number | null } | null;
  parent: number | null;
  deleted: boolean;
}

export class FakeBitbucket {
  readonly apiUrl: string;
  readonly token: string;
  readonly workspace: string;
  scopes: string[] | null = ["repository", "pullrequest:write", "webhook"];
  me = { uuid: "{0b0b0b0b-0000-4000-8000-000000000001}", nickname: "openreview-bot" };
  repos: { uuid: string; fullName: string; mainbranch: string }[] = [];
  hooks: { uuid: string; fullName: string; url: string; secret: string; events: string[] }[] = [];
  deletedHooks: string[] = [];
  comments: BbComment[] = [];
  members = new Set<string>();
  world?: ScmWorld & { uuid: string };
  rejectLines = new Set<number>();
  private nextId = 8000;
  readonly http: ReturnType<typeof fakeFetch>;

  constructor(opts: { apiUrl?: string; token?: string; workspace?: string } = {}) {
    this.apiUrl = opts.apiUrl ?? "https://api.bitbucket.example/2.0";
    this.token = opts.token ?? ["bbtok", "test"].join("-");
    this.workspace = opts.workspace ?? "acme";
    this.http = fakeFetch((req) => this.handle(req));
  }

  get fetch() {
    return this.http.fetch;
  }

  get requests(): RecordedRequest[] {
    return this.http.requests;
  }

  seed(world: ScmWorld, uuid = "{1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d}") {
    this.world = { ...world, uuid };
    if (!this.repos.some((r) => r.uuid === uuid)) this.repos.push({ uuid, fullName: world.repo, mainbranch: world.defaultBranch });
  }

  addComment(c: { raw: string; nickname: string; uuid?: string; inline?: { path: string; to: number | null } | null; parent?: number | null }): BbComment {
    const comment: BbComment = {
      id: this.nextId++,
      raw: c.raw,
      user: { uuid: c.uuid ?? "{77777777-0000-4000-8000-000000000077}", nickname: c.nickname },
      inline: c.inline ?? null,
      parent: c.parent ?? null,
      deleted: false,
    };
    this.comments.push(comment);
    return comment;
  }

  private commentJson(c: BbComment) {
    return { id: c.id, content: { raw: c.raw }, user: c.user, deleted: c.deleted, ...(c.inline ? { inline: c.inline } : {}), ...(c.parent ? { parent: { id: c.parent } } : {}) };
  }

  private page(values: unknown[]) {
    return jsonResponse({ pagelen: values.length, values });
  }

  private full(hash: string): string | null {
    const w = this.world!;
    return [w.pr.base, w.pr.head, ...w.commits.map((c) => c.sha)].find((s) => s.startsWith(hash)) ?? null;
  }

  private handle(req: RecordedRequest): Response {
    if (req.headers.authorization !== `Bearer ${this.token}`) return jsonResponse({ type: "error", error: { message: "Unauthorized" } }, 401);
    const { parts } = segments(req.url, "/2.0");
    const m = req.method;
    if (parts[0] === "user") return jsonResponse(this.me);
    if (parts[0] === "workspaces" && parts[1] === this.workspace) {
      if (parts[2] === "members") return this.members.has(parts[3] ?? "") ? jsonResponse({ user: { uuid: parts[3] } }) : notFound();
      return jsonResponse({ uuid: "{ws-uuid}", slug: this.workspace, name: "Acme" }, 200, this.scopes ? { "x-oauth-scopes": this.scopes.join(", ") } : {});
    }
    if (parts[0] !== "repositories" || parts[1] !== this.workspace) return notFound();
    if (parts.length === 2) {
      return this.page(this.repos.map((r) => ({ uuid: r.uuid, full_name: r.fullName, is_private: true, mainbranch: { name: r.mainbranch } })));
    }
    const repo = this.repos.find((r) => r.fullName === `${parts[1]}/${parts[2]}`);
    if (!repo) return notFound();
    const sub = parts.slice(3);
    if (sub.length === 0) return jsonResponse({ uuid: repo.uuid, full_name: repo.fullName, is_private: true, mainbranch: { name: repo.mainbranch } });
    if (sub[0] === "hooks") {
      if (m === "POST") {
        const body = req.body as { url: string; secret: string; events: string[] };
        const hook = { uuid: `{${crypto.randomUUID()}}`, fullName: repo.fullName, url: body.url, secret: body.secret, events: body.events };
        this.hooks.push(hook);
        return jsonResponse({ uuid: hook.uuid }, 201);
      }
      if (m === "DELETE") {
        const uuid = sub[1]!;
        const before = this.hooks.length;
        this.hooks = this.hooks.filter((h) => h.uuid !== uuid);
        if (before === this.hooks.length) return notFound();
        this.deletedHooks.push(uuid);
        return new Response(null, { status: 204 });
      }
    }
    const w = this.world;
    if (!w || w.repo !== repo.fullName) return notFound();
    if (sub[0] === "commit") {
      if (sub[2] === "statuses") {
        if (!w.pr.head.startsWith(sub[1]!)) return this.page([]);
        return this.page(w.checks.map((c) => ({ key: c.name, name: c.name, state: c.ok ? "SUCCESSFUL" : "FAILED" })));
      }
      const full = this.full(sub[1]!);
      return full ? jsonResponse({ hash: full }) : notFound();
    }
    if (sub[0] === "merge-base") return jsonResponse({ hash: w.pr.base });
    if (sub[0] === "src") {
      const ref = sub[1]!;
      const path = sub.slice(2).join("/");
      if (!path) return this.page(w.treeAt(ref).map((p) => ({ path: p, type: "commit_file" })));
      const content = w.contentAt(ref, path);
      return content === null ? notFound() : text(content);
    }
    if (sub[0] === "diffstat") {
      const [headSha, baseSha] = (sub[1] ?? "").split("..");
      return this.page((w.compareAt?.(baseSha ?? "", headSha ?? "") ?? []).map((c) => ({ status: c.status, old: { path: c.path }, new: { path: c.path } })));
    }
    if (sub[0] !== "pullrequests" || Number(sub[1]) !== w.pr.number) return notFound();
    const pr = sub.slice(2);
    if (pr.length === 0) {
      return jsonResponse({
        id: w.pr.number,
        title: w.pr.title,
        description: w.pr.body,
        author: { uuid: "{author}", nickname: w.pr.author },
        state: "OPEN",
        draft: Boolean(w.pr.draft),
        // Bitbucket abbreviates commit hashes in pull request objects.
        source: { branch: { name: w.pr.sourceBranch }, commit: { hash: w.pr.head.slice(0, 12) } },
        destination: { branch: { name: w.pr.targetBranch }, commit: { hash: w.pr.base.slice(0, 12) } },
        links: { html: { href: `https://bitbucket.example/${w.repo}/pull-requests/${w.pr.number}` } },
        participants: w.approvals.map((u, i) => ({ user: { uuid: `{0000000${i}-0000-4000-8000-000000000000}`, nickname: u }, approved: true, state: "approved", participated_on: "2026-10-01T10:00:00Z" })),
      });
    }
    switch (pr[0]) {
      case "diffstat":
        return this.page(w.files.map((f) => ({ status: f.status, old: f.status === "added" ? null : { path: f.previousPath ?? f.path }, new: f.status === "removed" ? null : { path: f.path } })));
      case "diff":
        return text(
          w.files
            .map((f) => {
              const oldP = f.previousPath ?? f.path;
              return [`diff --git a/${oldP} b/${f.path}`, "index 1111111..2222222 100644", `--- ${f.status === "added" ? "/dev/null" : `a/${oldP}`}`, `+++ ${f.status === "removed" ? "/dev/null" : `b/${f.path}`}`, f.patch].join("\n");
            })
            .join("\n"),
        );
      case "commits":
        return this.page([...w.commits].reverse().map((c) => ({ hash: c.sha, message: c.message, date: c.date, author: { raw: `${c.author} <${c.author}@x>`, user: { nickname: c.author } } })));
      case "comments": {
        if (pr.length === 1 && m === "GET") return this.page(this.comments.map((c) => this.commentJson(c)));
        if (pr.length === 1 && m === "POST") {
          const body = req.body as { content: { raw: string }; inline?: { path: string; to: number }; parent?: { id: number } };
          if (body.inline && this.rejectLines.has(body.inline.to)) return jsonResponse({ type: "error", error: { message: "line not in diff" } }, 400);
          const c = this.addComment({ raw: body.content.raw, nickname: this.me.nickname, uuid: this.me.uuid, inline: body.inline ? { path: body.inline.path, to: body.inline.to } : null, parent: body.parent?.id ?? null });
          return jsonResponse(this.commentJson(c), 201);
        }
        const c = this.comments.find((x) => x.id === Number(pr[1]));
        if (!c) return notFound();
        if (m === "PUT") c.raw = (req.body as { content: { raw: string } }).content.raw;
        return jsonResponse(this.commentJson(c));
      }
      default:
        return notFound();
    }
  }
}
