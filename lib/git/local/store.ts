/**
 * The local git host's pull request store (R6.22): pull requests, comments, reviews, and reactions in Postgres
 * (`local_pull_requests`, `local_comments`), tenant-scoped like every other table. Branches and commits live in the
 * bare repositories (`./repo.ts`).
 */
import { createHash } from "node:crypto";
import { and, asc, eq, max } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { installations, localComments, localPullRequests, orgs, repos } from "@/lib/db/schema";
import { LocalRepoError, mergeBase, repoDir, resolveCommit } from "./repo";

export const LOCAL_PROVIDER = "local";

export type LocalPullRequestRow = typeof localPullRequests.$inferSelect;
export type LocalCommentRow = typeof localComments.$inferSelect;

/** A stable positive 31-bit id for a name (local installations and repositories have no host-assigned ids). */
export function localExternalId(...parts: string[]): number {
  const h = createHash("sha256").update(parts.join("\0")).digest();
  return (h.readUInt32BE(0) & 0x7fffffff) || 1;
}

/** The org and installation row of a local installation id. */
export async function localInstallation(db: Db, externalId: number) {
  const [row] = await db
    .select()
    .from(installations)
    .where(and(eq(installations.provider, LOCAL_PROVIDER), eq(installations.externalId, externalId)));
  return row;
}

/**
 * Creates (or reuses) an org's local installation for `owner` and returns it. Its external id is derived from the org
 * and owner, so running the demo again finds the same installation.
 */
export async function ensureLocalInstallation(db: Db, input: { orgId: string; owner: string; orgName?: string }) {
  // An existing org keeps its name.
  await db.insert(orgs).values({ id: input.orgId, name: input.orgName ?? input.orgId }).onConflictDoNothing();
  const externalId = localExternalId("local-installation", input.orgId, input.owner);
  const values = {
    orgId: input.orgId,
    provider: LOCAL_PROVIDER,
    externalId,
    accountLogin: input.owner,
    accountType: "Local",
    repositorySelection: "all",
    permissions: { metadata: "read", contents: "read", pull_requests: "write", issues: "write", checks: "read" },
  };
  await db
    .insert(installations)
    .values(values)
    .onConflictDoUpdate({ target: [installations.provider, installations.externalId], set: { accountLogin: input.owner, suspended: false }, setWhere: eq(installations.orgId, input.orgId) });
  const row = await localInstallation(db, externalId);
  if (!row || row.orgId !== input.orgId) throw new LocalRepoError("the local installation belongs to another organization");
  return row;
}

/** The repository row (tenant-scoped through its installation) a client of `installationExternalId` addresses. */
export async function localRepo(db: Db, installationExternalId: number, fullName: string) {
  const inst = await localInstallation(db, installationExternalId);
  if (!inst) throw new LocalRepoError(`no local installation ${installationExternalId}`);
  const [repo] = await db
    .select()
    .from(repos)
    .where(scoped(repos, inst.orgId, eq(repos.installationId, inst.id), eq(repos.fullName, fullName)));
  if (!repo) throw new LocalRepoError(`repository ${fullName} is not connected to local installation ${installationExternalId}`);
  return { installation: inst, repo };
}

export async function getLocalPullRequest(db: Db, orgId: string, repoId: number, number: number): Promise<LocalPullRequestRow | undefined> {
  const [row] = await db.select().from(localPullRequests).where(scoped(localPullRequests, orgId, eq(localPullRequests.repoId, repoId), eq(localPullRequests.number, number)));
  return row;
}

/** A local pull request by its row id, within an org. */
export async function getLocalPullRequestById(db: Db, orgId: string, id: number): Promise<LocalPullRequestRow | undefined> {
  const [row] = await db.select().from(localPullRequests).where(scoped(localPullRequests, orgId, eq(localPullRequests.id, id)));
  return row;
}

/**
 * Brings an open pull request's head and base up to date with its branches (a push to the head branch moves the pull
 * request, as on a git host). Closed pull requests keep the commits they were closed at.
 */
export async function refreshLocalPullRequest(db: Db, root: string, fullName: string, pr: LocalPullRequestRow): Promise<LocalPullRequestRow> {
  if (pr.state !== "open") return pr;
  const dir = repoDir(root, fullName);
  const head = await resolveCommit(dir, `refs/heads/${pr.headRef}`);
  const baseTip = await resolveCommit(dir, `refs/heads/${pr.baseRef}`);
  if (!head || !baseTip) return pr;
  const base = (await mergeBase(dir, baseTip, head)) ?? baseTip;
  if (head === pr.headSha && base === pr.baseSha) return pr;
  const [row] = await db
    .update(localPullRequests)
    .set({ headSha: head, baseSha: base })
    .where(scoped(localPullRequests, pr.orgId, eq(localPullRequests.id, pr.id)))
    .returning();
  return row ?? pr;
}

/** Opens a pull request from `headRef` into `baseRef` of a connected local repository; returns the row. */
export async function openLocalPullRequest(
  db: Db,
  root: string,
  input: { orgId: string; repoId: number; fullName: string; title: string; body?: string; author: string; baseRef: string; headRef: string; draft?: boolean; number?: number },
): Promise<LocalPullRequestRow> {
  const dir = repoDir(root, input.fullName);
  const head = await resolveCommit(dir, `refs/heads/${input.headRef}`);
  const baseTip = await resolveCommit(dir, `refs/heads/${input.baseRef}`);
  if (!head) throw new LocalRepoError(`branch ${input.headRef} does not exist in ${input.fullName}`);
  if (!baseTip) throw new LocalRepoError(`branch ${input.baseRef} does not exist in ${input.fullName}`);
  const base = (await mergeBase(dir, baseTip, head)) ?? baseTip;
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ n: max(localPullRequests.number) })
      .from(localPullRequests)
      .where(scoped(localPullRequests, input.orgId, eq(localPullRequests.repoId, input.repoId)));
    const [row] = await tx
      .insert(localPullRequests)
      .values({
        orgId: input.orgId,
        repoId: input.repoId,
        number: input.number ?? (last?.n ?? 0) + 1,
        title: input.title,
        body: input.body ?? "",
        author: input.author,
        baseRef: input.baseRef,
        headRef: input.headRef,
        baseSha: base,
        headSha: head,
        draft: input.draft ?? false,
      })
      .returning();
    return row!;
  });
}

/** Closes (or merges) a local pull request. */
export async function closeLocalPullRequest(db: Db, orgId: string, id: number, merged = false) {
  await db
    .update(localPullRequests)
    .set({ state: merged ? "merged" : "closed", closedAt: new Date() })
    .where(scoped(localPullRequests, orgId, eq(localPullRequests.id, id)));
}

export async function listLocalComments(db: Db, pr: Pick<LocalPullRequestRow, "id" | "orgId">, kind?: LocalCommentRow["kind"]): Promise<LocalCommentRow[]> {
  return db
    .select()
    .from(localComments)
    .where(scoped(localComments, pr.orgId, eq(localComments.pullRequestId, pr.id), kind ? eq(localComments.kind, kind) : undefined))
    .orderBy(asc(localComments.id));
}

export async function getLocalComment(db: Db, pr: Pick<LocalPullRequestRow, "id" | "orgId">, id: number, kind: LocalCommentRow["kind"]): Promise<LocalCommentRow | undefined> {
  const [row] = await db
    .select()
    .from(localComments)
    .where(scoped(localComments, pr.orgId, eq(localComments.pullRequestId, pr.id), eq(localComments.kind, kind), eq(localComments.id, id)));
  return row;
}

type NewComment = Omit<typeof localComments.$inferInsert, "orgId" | "pullRequestId" | "id">;

/** Adds a comment, inline comment, or review to a local pull request (also how a person comments in local mode). */
export async function addLocalComment(db: Db, pr: Pick<LocalPullRequestRow, "id" | "orgId">, comment: NewComment): Promise<LocalCommentRow> {
  const [row] = await db
    .insert(localComments)
    .values({ ...comment, orgId: pr.orgId, pullRequestId: pr.id })
    .returning();
  return row!;
}

export async function updateLocalComment(db: Db, pr: Pick<LocalPullRequestRow, "id" | "orgId">, id: number, kind: LocalCommentRow["kind"], body: string): Promise<LocalCommentRow | undefined> {
  const [row] = await db
    .update(localComments)
    .set({ body })
    .where(scoped(localComments, pr.orgId, eq(localComments.pullRequestId, pr.id), eq(localComments.kind, kind), eq(localComments.id, id)))
    .returning();
  return row;
}

/** Adds a reaction (`+1`, `-1`, ...) by `user` to an inline comment. */
export async function addLocalReaction(db: Db, pr: Pick<LocalPullRequestRow, "id" | "orgId">, commentId: number, reaction: { content: string; user: string }) {
  const comment = await getLocalComment(db, pr, commentId, "review_comment");
  if (!comment) throw new LocalRepoError(`no review comment ${commentId}`);
  const reactions = [...comment.reactions, { id: comment.reactions.length + 1, ...reaction }];
  await db.update(localComments).set({ reactions }).where(scoped(localComments, pr.orgId, eq(localComments.id, commentId)));
}
