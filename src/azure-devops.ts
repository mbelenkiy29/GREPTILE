import { z } from "zod";
import { catalogPageSize, changeMetadataSchema, numberedPage, validateChangePage, type ChangeMetadata, type ChangePage } from "./change-metadata";
import { reviewLinks } from "./review-summary";
import { repositorySourceUrl } from "./source-url";
import type { Finding, SourceFile, ChangedFile } from "./engine/types";
import { findingComment, summaryMarker } from "./github";
import { changedLines } from "./engine/diff";
import { unifiedPatch } from "./text-diff";
import type { Scm, ScmChange } from "./gitlab";

// Azure DevOps Services / Server (REST 7.1). Repositories are "<project>/<repo>" with the repo GUID
// as externalId. Credentials: a PAT, or JSON {tenantId, clientId, clientSecret} for a Microsoft
// Entra service principal. Azure returns changed files without patches, so diffs are computed from
// the base and head blobs. Comment threads carry OpenReview's hidden markers for idempotency.
const apiVersion = "7.1";
const devOpsScope = "499b84ac-1321-427f-aa17-267ca6975798/.default";
export class AzureDevOpsError extends Error { constructor(readonly status: number, path: string) { super(`Azure DevOps ${status} at ${path.split("?")[0]}`); } }
const entra = z.object({ tenantId: z.string().uuid(), clientId: z.string().uuid(), clientSecret: z.string().min(8) });
const identity = z.object({ id: z.string(), uniqueName: z.string().optional(), displayName: z.string().optional() });
const commit = z.object({ commitId: z.string().regex(/^[a-f0-9]{40}$/) });
const prSchema = z.object({ pullRequestId: z.number().int().positive(), title: z.string(), description: z.string().nullish(), isDraft: z.boolean().optional(), status: z.enum(["active", "completed", "abandoned", "notSet", "all"]), createdBy: identity, sourceRefName: z.string(), targetRefName: z.string(), lastMergeSourceCommit: commit, lastMergeTargetCommit: commit, repository: z.object({ id: z.string(), name: z.string(), project: z.object({ name: z.string() }) }) });
const threadComment = z.object({ id: z.number().int(), parentCommentId: z.number().int().optional(), content: z.string().nullish(), author: identity, commentType: z.string().optional(), isDeleted: z.boolean().optional() });
const thread = z.object({ id: z.number().int().positive(), status: z.string().nullish(), comments: z.array(threadComment), isDeleted: z.boolean().optional(), threadContext: z.object({ filePath: z.string(), rightFileStart: z.object({ line: z.number() }).nullish() }).nullish() });
const changeEntry = z.object({ changeTrackingId: z.number().int(), changeType: z.string(), originalPath: z.string().optional(), item: z.object({ path: z.string(), objectId: z.string().optional(), originalObjectId: z.string().optional() }) });
const stripRef = (ref: string) => ref.replace(/^refs\/heads\//, "");
export const azureThreadStatus = { active: 1, closed: 4 } as const;

export class AzureDevOps implements Scm {
  readonly supportsApproval = false;
  private token?: { value: string; expiresAt: number };
  constructor(private base: string, private credential: string, private repositoryId?: string, private fetchImpl: typeof fetch = fetch) {}
  private async authorization() {
    if (!this.credential.trim().startsWith("{")) return "Basic " + Buffer.from(":" + this.credential.trim()).toString("base64");
    if (this.token && this.token.expiresAt > Date.now() + 60000) return "Bearer " + this.token.value;
    const sp = entra.parse(JSON.parse(this.credential));
    const response = await this.fetchImpl(`https://login.microsoftonline.com/${sp.tenantId}/oauth2/v2.0/token`, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: sp.clientId, client_secret: sp.clientSecret, scope: devOpsScope }), signal: AbortSignal.timeout(30000) });
    const data = z.object({ access_token: z.string().min(10), expires_in: z.number().int().positive() }).safeParse(await response.json().catch(() => null));
    if (!response.ok || !data.success) throw new AzureDevOpsError(response.status, "/oauth2/v2.0/token");
    this.token = { value: data.data.access_token, expiresAt: Date.now() + data.data.expires_in * 1000 };
    return "Bearer " + this.token.value;
  }
  private url(path: string) { if (path.includes("://") || path.startsWith("/")) throw new Error("Invalid Azure DevOps API path"); return `${this.base}/${path}${path.includes("?") ? "&" : "?"}api-version=${apiVersion}`; }
  private async send(path: string, init: RequestInit = {}) {
    const response = await this.fetchImpl(this.url(path), { ...init, redirect: "error", headers: { authorization: await this.authorization(), accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new AzureDevOpsError(response.status, path);
    return response;
  }
  async request<T>(path: string, schema: z.ZodType<T>, method?: "POST" | "PATCH", body?: unknown): Promise<T> {
    return schema.parse(await (await this.send(path, method ? { method, body: JSON.stringify(body ?? {}) } : {})).json());
  }
  private repo(repository: string) {
    const [project] = repository.split("/");
    if (!project || !this.repositoryId || !/^[0-9a-f-]{36}$/i.test(this.repositoryId)) throw new Error("Azure DevOps repository identity missing");
    return `${encodeURIComponent(project)}/_apis/git/repositories/${this.repositoryId}`;
  }
  private webUrl(repository: string) { const [project, ...name] = repository.split("/"); return `${this.base}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name.join("/"))}`; }
  sourceUrl(repository: string, revision: string, file: string) { return repositorySourceUrl("azure-devops", this.base, repository, revision, file); }
  async identity() { return z.object({ authenticatedUser: identity }).parse(await (await this.send("_apis/connectionData")).json()).authenticatedUser; }

  async repositories() {
    const list = await this.request("_apis/git/repositories", z.object({ value: z.array(z.object({ id: z.string(), name: z.string(), defaultBranch: z.string().optional(), remoteUrl: z.string().url(), isDisabled: z.boolean().optional(), project: z.object({ id: z.string(), name: z.string() }) })) }));
    return list.value.filter((r) => r.defaultBranch && !r.isDisabled).map((r) => ({ externalId: r.id, fullName: `${r.project.name}/${r.name}`, defaultBranch: stripRef(r.defaultBranch!), remoteUrl: r.remoteUrl, group: { externalId: r.project.id, name: r.project.name.slice(0, 100) } }));
  }
  async head(repository: string, branch: string) {
    const refs = await this.request(`${this.repo(repository)}/refs?filter=${encodeURIComponent("heads/" + branch)}`, z.object({ value: z.array(z.object({ name: z.string(), objectId: z.string() })) }));
    const ref = refs.value.find((r) => r.name === "refs/heads/" + branch);
    if (!ref) throw new Error("Branch not found");
    return ref.objectId;
  }
  async branches(repository: string) {
    const refs = await this.request(`${this.repo(repository)}/refs?filter=heads/&$top=201`, z.object({ value: z.array(z.object({ name: z.string(), objectId: z.string(), isLocked: z.boolean().optional() })) }));
    return { branches: refs.value.slice(0, 200).map((r) => ({ name: stripRef(r.name), sha: r.objectId, protected: Boolean(r.isLocked) })), limited: refs.value.length > 200 };
  }
  async tree(repository: string, sha: string) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Tree requires an exact commit");
    const { treeId } = await this.request(`${this.repo(repository)}/commits/${sha}`, z.object({ treeId: z.string() }));
    const tree = await this.request(`${this.repo(repository)}/trees/${treeId}?recursive=true`, z.object({ treeEntries: z.array(z.object({ relativePath: z.string(), objectId: z.string(), gitObjectType: z.string(), size: z.number().optional() })) }));
    return tree.treeEntries.filter((e) => e.gitObjectType === "blob").map((e) => ({ path: e.relativePath, sha: e.objectId, type: "blob", ...(e.size !== undefined ? { size: e.size } : {}) }));
  }
  async blob(repository: string, path: string, sha: string): Promise<SourceFile> {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Blob requires an object ID");
    const response = await this.send(`${this.repo(repository)}/blobs/${sha}?$format=octetstream`, { headers: { accept: "application/octet-stream" } });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 200000) { await response.body?.cancel(); return { path, sha, size: declared, content: "" }; }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 200000) return { path, sha, size: bytes.length, content: "" };
    return { path, sha, content: new TextDecoder().decode(bytes) };
  }
  async changeMetadata(repository: string, number: number): Promise<ChangeMetadata> {
    const pr = await this.request(`${this.repo(repository)}/pullrequests/${number}`, prSchema);
    if (pr.pullRequestId !== number) throw new Error("Azure DevOps change identity mismatch");
    return changeMetadataSchema.parse({ number, title: pr.title, html_url: `${this.webUrl(repository)}/pullrequest/${number}`, draft: Boolean(pr.isDraft), state: pr.status === "active" ? "open" : pr.status === "completed" ? "merged" : "closed", user: { login: pr.createdBy.uniqueName ?? pr.createdBy.id }, head: { sha: pr.lastMergeSourceCommit.commitId, ref: stripRef(pr.sourceRefName) }, base: { sha: pr.lastMergeTargetCommit.commitId, ref: stripRef(pr.targetRefName) }, revisionKey: pr.lastMergeTargetCommit.commitId + ":" + pr.lastMergeSourceCommit.commitId });
  }
  async openChanges(repository: string, cursor: string | null): Promise<ChangePage> {
    const page = numberedPage(cursor), rows = await this.request(`${this.repo(repository)}/pullrequests?searchCriteria.status=active&$top=${catalogPageSize}&$skip=${(page - 1) * catalogPageSize}`, z.object({ value: z.array(z.object({ pullRequestId: z.number().int().positive() })).max(catalogPageSize) }));
    return validateChangePage({ numbers: rows.value.map((r) => r.pullRequestId), next: rows.value.length === catalogPageSize ? String(page + 1) : null }, cursor);
  }
  private async iteration(repository: string, number: number) {
    const iterations = await this.request(`${this.repo(repository)}/pullRequests/${number}/iterations`, z.object({ value: z.array(z.object({ id: z.number().int().positive(), sourceRefCommit: commit, commonRefCommit: commit.optional() })).min(1) }));
    return iterations.value.reduce((latest, i) => (i.id > latest.id ? i : latest));
  }
  private async changes(repository: string, number: number, iterationId: number) {
    const out: z.infer<typeof changeEntry>[] = [];
    for (let skip = 0, page = 0; page < 5; page++) {
      const result = await this.request(`${this.repo(repository)}/pullRequests/${number}/iterations/${iterationId}/changes?$top=2000&$skip=${skip}&$compareTo=0`, z.object({ changeEntries: z.array(changeEntry), nextSkip: z.number().int().optional() }));
      out.push(...result.changeEntries);
      if (!result.nextSkip) return { entries: out, complete: true };
      skip = result.nextSkip;
    }
    return { entries: out, complete: false };
  }
  // One file's unified patch, computed from the base and head blobs (binary files get no patch).
  private async patch(repository: string, entry: z.infer<typeof changeEntry>) {
    const path = entry.item.path.replace(/^\//, "");
    const removed = entry.changeType.includes("delete"), added = entry.changeType.includes("add");
    const before = !added && entry.item.originalObjectId ? await this.blob(repository, path, entry.item.originalObjectId) : null;
    const after = !removed && entry.item.objectId ? await this.blob(repository, path, entry.item.objectId) : null;
    const text = (f: SourceFile | null) => f?.content ?? "";
    const tooLarge = (before && !before.content && before.size) || (after && !after.content && after.size);
    const binary = /\u0000/.test(text(before) + text(after));
    return { path, file: { path, ...(entry.originalPath ? { previousPath: entry.originalPath.replace(/^\//, "") } : {}), status: removed ? "removed" : added ? "added" : entry.changeType.includes("rename") ? "renamed" : "modified", patch: tooLarge || binary ? "" : unifiedPatch(text(before), text(after)) } as ChangedFile, omitted: tooLarge ? "File too large for a computed diff" : binary ? "Binary file" : undefined };
  }
  async pullRequest(repository: string, number: number): Promise<ScmChange> {
    const prefix = `${this.repo(repository)}/pullRequests/${number}`;
    const pr = await this.request(`${this.repo(repository)}/pullrequests/${number}`, prSchema);
    const iteration = await this.iteration(repository, number);
    if (iteration.sourceRefCommit.commitId !== pr.lastMergeSourceCommit.commitId) throw new Error("Azure DevOps revision changed during ingestion");
    const { entries, complete } = await this.changes(repository, number, iteration.id);
    const files = entries.filter((e) => !e.item.path.endsWith("/") && e.changeType !== "none").slice(0, 300);
    const patches = [];
    for (const entry of files) patches.push(await this.patch(repository, entry));
    const [threads, commits, statuses] = await Promise.all([
      this.request(`${prefix}/threads`, z.object({ value: z.array(thread) })),
      this.request(`${prefix}/commits`, z.object({ value: z.array(commit) })),
      this.request(`${prefix}/statuses`, z.object({ value: z.array(z.object({ state: z.string(), context: z.object({ name: z.string(), genre: z.string().optional() }) })) })),
    ]);
    const latest = await this.request(`${this.repo(repository)}/pullrequests/${number}`, prSchema);
    if (latest.lastMergeSourceCommit.commitId !== pr.lastMergeSourceCommit.commitId || latest.lastMergeTargetCommit.commitId !== pr.lastMergeTargetCommit.commitId || latest.status !== pr.status) throw new Error("Azure DevOps revision changed during ingestion");
    const omitted = [...patches.filter((p) => p.omitted).map((p) => ({ path: p.path, reason: p.omitted! })), ...(!complete || entries.length > files.length ? [{ path: `(${entries.length - files.length}+ more files)`, reason: "Azure DevOps change listing exceeded the review limit" }] : [])];
    return {
      number, title: pr.title, body: pr.description ?? null, draft: Boolean(pr.isDraft), state: pr.status === "active" ? "open" : "closed", html_url: `${this.webUrl(repository)}/pullrequest/${number}`, user: { login: pr.createdBy.uniqueName ?? pr.createdBy.id }, authorExternalId: pr.createdBy.id,
      head: { sha: pr.lastMergeSourceCommit.commitId, ref: stripRef(pr.sourceRefName) }, base: { sha: iteration.commonRefCommit?.commitId ?? pr.lastMergeTargetCommit.commitId, ref: stripRef(pr.targetRefName) },
      revisionKey: pr.lastMergeTargetCommit.commitId + ":" + pr.lastMergeSourceCommit.commitId,
      diff: patches.map((p) => p.file),
      comments: threads.value.filter((t) => !t.isDeleted).flatMap((t) => t.comments.filter((c) => !c.isDeleted && c.commentType !== "system").map((c) => ({ id: `${t.id}:${c.id}`, body: c.content ?? "", path: t.threadContext?.filePath.replace(/^\//, "") ?? "", line: t.threadContext?.rightFileStart?.line ?? null, user: { login: c.author.uniqueName ?? c.author.id } }))),
      reviews: [], commits: commits.value.map((c) => ({ sha: c.commitId })),
      checks: statuses.value.map((s) => ({ name: s.context.genre ? `${s.context.genre}/${s.context.name}` : s.context.name, status: s.state === "pending" ? "in_progress" : "completed", conclusion: s.state === "succeeded" ? "success" : s.state === "failed" || s.state === "error" ? "failure" : "neutral" })),
      omitted,
    } as unknown as ScmChange;
  }
  async publish(repository: string, number: number, sha: string, summary: string, findings: Finding[], marker: string, style = "detailed", revisionKey?: string, unresolvedCount = findings.length) {
    const prefix = `${this.repo(repository)}/pullRequests/${number}`;
    const pr = await this.request(`${this.repo(repository)}/pullrequests/${number}`, prSchema);
    const current = (p: z.infer<typeof prSchema>) => p.status === "active" && p.lastMergeSourceCommit.commitId === sha && (revisionKey === undefined || revisionKey === p.lastMergeTargetCommit.commitId + ":" + p.lastMergeSourceCommit.commitId);
    if (!current(pr)) throw new Error("Pull request revision changed or closed");
    const recheck = async () => { if (!current(await this.request(`${this.repo(repository)}/pullrequests/${number}`, prSchema))) throw new Error("Pull request revision changed or closed"); };
    const me = await this.identity();
    const threads = (await this.request(`${prefix}/threads`, z.object({ value: z.array(thread) }))).value.filter((t) => !t.isDeleted);
    const mine = (t: z.infer<typeof thread>) => t.comments[0]?.author.id === me.id;
    const comments: { id: string; fingerprint: string }[] = [];
    if (findings.length) {
      const iteration = await this.iteration(repository, number);
      if (iteration.sourceRefCommit.commitId !== sha) throw new Error("Pull request revision changed");
      const { entries } = await this.changes(repository, number, iteration.id);
      for (const f of findings) {
        const findingMarker = `<!-- openreview:${marker}:finding:${f.fingerprint} -->`;
        const prior = threads.find((t) => mine(t) && (t.comments[0]?.content ?? "").includes(findingMarker) && t.threadContext?.filePath === "/" + f.filePath && t.threadContext.rightFileStart?.line === f.startLine);
        if (prior) { comments.push({ id: `${prior.id}:${prior.comments[0].id}`, fingerprint: f.fingerprint }); continue; }
        const entry = entries.find((e) => e.item.path === "/" + f.filePath);
        if (!entry) throw new Error("Finding file not in the pull request");
        const { file } = await this.patch(repository, entry);
        if (!changedLines(file.patch).has(f.startLine)) throw new Error("Finding line not in the computed diff");
        await recheck();
        const created = await this.request(`${prefix}/threads`, thread, "POST", { comments: [{ parentCommentId: 0, commentType: 1, content: findingComment(f, style) + "\n\n" + findingMarker + (process.env.APP_URL ? `\n\n[Fix with your agent](${process.env.APP_URL}/fix/${marker}?finding=${f.fingerprint})` : "") }], status: azureThreadStatus.active, threadContext: { filePath: "/" + f.filePath, rightFileStart: { line: f.startLine, offset: 1 }, rightFileEnd: { line: Math.max(f.startLine, f.endLine), offset: 1 } }, pullRequestThreadContext: { changeTrackingId: entry.changeTrackingId, iterationContext: { firstComparingIteration: 1, secondComparingIteration: iteration.id } } });
        if (created.comments[0]?.author.id !== me.id) throw new Error("Azure DevOps returned another publication identity");
        comments.push({ id: `${created.id}:${created.comments[0].id}`, fingerprint: f.fingerprint });
      }
    }
    await recheck();
    // One summary thread per pull request, found by its hidden marker and edited in place; it is
    // closed so it never blocks "comments must be resolved" branch policies.
    const body = "## OpenReview\n\n" + summary + reviewLinks(marker, unresolvedCount) + `\n\n**Last reviewed commit:** \`${sha.slice(0, 7)}\`\n\n${summaryMarker}\n<!-- openreview:${marker} -->\n<!-- openreview-revision:${sha} -->`;
    const existing = threads.filter((t) => mine(t) && (t.comments[0]?.content ?? "").includes(summaryMarker)).at(-1);
    if (existing) {
      if (existing.comments[0].content === body) return { id: String(existing.id), reused: true, comments };
      await this.request(`${prefix}/threads/${existing.id}/comments/${existing.comments[0].id}`, threadComment, "PATCH", { content: body });
      return { id: String(existing.id), reused: false, comments };
    }
    const created = await this.request(`${prefix}/threads`, thread, "POST", { comments: [{ parentCommentId: 0, commentType: 1, content: body }], status: azureThreadStatus.closed });
    if (created.comments[0]?.author.id !== me.id) throw new Error("Azure DevOps returned another publication identity");
    return { id: String(created.id), reused: false, comments };
  }
  async reply(repository: string, number: number, body: string, parent?: string | number, marker?: string) {
    const prefix = `${this.repo(repository)}/pullRequests/${number}`;
    if (marker) {
      const me = await this.identity(), tag = `<!-- openreview:${marker} -->`;
      for (const t of (await this.request(`${prefix}/threads`, z.object({ value: z.array(thread) }))).value) { const c = t.comments.find((c) => c.author.id === me.id && (c.content ?? "").includes(tag)); if (c) return { id: `${t.id}:${c.id}` }; }
      body += "\n\n" + tag;
    }
    if (parent !== undefined) {
      const threadId = Number(String(parent).split(":")[0]);
      if (!Number.isSafeInteger(threadId) || threadId < 1) throw new Error("Invalid Azure DevOps thread identity");
      const created = await this.request(`${prefix}/threads/${threadId}/comments`, threadComment, "POST", { content: body, parentCommentId: 1, commentType: 1 });
      return { id: `${threadId}:${created.id}` };
    }
    const created = await this.request(`${prefix}/threads`, thread, "POST", { comments: [{ parentCommentId: 0, commentType: 1, content: body }], status: azureThreadStatus.closed });
    return { id: `${created.id}:${created.comments[0].id}` };
  }
  // Pull request status ("openreview" context): pending while reviewing, then the outcome.
  async reportStatus(repository: string, number: number, state: "pending" | "succeeded" | "failed" | "notApplicable" | "error", description: string, targetUrl?: string) {
    await this.request(`${this.repo(repository)}/pullRequests/${number}/statuses`, z.object({ id: z.number() }), "POST", { state, description: description.slice(0, 250), context: { name: "openreview", genre: "code-review" }, ...(targetUrl ? { targetUrl } : {}) });
  }
}
