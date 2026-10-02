import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { installations, orgs, repos } from "@/lib/db/schema";
import type { GitHost, RemoteRepo } from "@/lib/git/types";
import { scoped } from "./tenant";

export class InstallationOwnershipError extends Error {}

export async function ensureOrg(db: Db, orgId: string, name: string) {
  await db.insert(orgs).values({ id: orgId, name }).onConflictDoUpdate({ target: orgs.id, set: { name } });
}

/**
 * Completes the GitHub App install flow for an org (R1.1): records the
 * installation under the org and syncs the repositories the user selected on
 * GitHub. An installation already linked to a different org cannot be claimed.
 */
export async function completeInstallation(
  db: Db,
  host: GitHost,
  input: { orgId: string; orgName: string; installationId: number },
) {
  const remote = await host.getInstallation(input.installationId);
  await ensureOrg(db, input.orgId, input.orgName);

  const [existing] = await db
    .select()
    .from(installations)
    .where(and(eq(installations.provider, host.provider), eq(installations.externalId, remote.id)));
  if (existing && existing.orgId !== input.orgId) {
    throw new InstallationOwnershipError("This installation is already connected to another organization.");
  }

  const [row] = await db
    .insert(installations)
    .values({ orgId: input.orgId, provider: host.provider, externalId: remote.id, accountLogin: remote.accountLogin })
    .onConflictDoUpdate({
      target: [installations.provider, installations.externalId],
      set: { accountLogin: remote.accountLogin, suspended: false },
    })
    .returning();

  const synced = await syncInstallationRepos(db, host, row!);
  return { installation: row!, repos: synced };
}

/** Mirrors the installation's repository selection into `repos` (adds new, removes deselected). */
export async function syncInstallationRepos(
  db: Db,
  host: GitHost,
  installation: { id: number; orgId: string; externalId: number },
  remoteRepos?: RemoteRepo[],
) {
  const list = remoteRepos ?? (await host.listInstallationRepos(installation.externalId));
  for (const r of list) {
    await db
      .insert(repos)
      .values({
        orgId: installation.orgId,
        installationId: installation.id,
        externalId: r.id,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        private: r.private,
      })
      .onConflictDoUpdate({
        target: [repos.installationId, repos.externalId],
        set: { fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private },
      });
  }
  const keep = list.map((r) => r.id);
  await db
    .delete(repos)
    .where(
      scoped(
        repos,
        installation.orgId,
        eq(repos.installationId, installation.id),
        keep.length ? notInArray(repos.externalId, keep) : undefined,
      ),
    );
  return listRepos(db, installation.orgId, installation.id);
}

export async function findInstallationByExternalId(db: Db, provider: string, externalId: number) {
  const [row] = await db
    .select()
    .from(installations)
    .where(and(eq(installations.provider, provider), eq(installations.externalId, externalId)));
  return row;
}

export async function listInstallations(db: Db, orgId: string) {
  return db.select().from(installations).where(scoped(installations, orgId));
}

export async function listRepos(db: Db, orgId: string, installationId?: number) {
  return db
    .select()
    .from(repos)
    .where(scoped(repos, orgId, installationId ? eq(repos.installationId, installationId) : undefined))
    .orderBy(repos.fullName);
}

export async function getRepo(db: Db, orgId: string, repoId: number) {
  const [row] = await db.select().from(repos).where(scoped(repos, orgId, eq(repos.id, repoId)));
  return row;
}

/** Turns reviews on or off for one of the org's repos. Returns false if the repo is not the org's. */
export async function setRepoEnabled(db: Db, orgId: string, repoId: number, enabled: boolean) {
  const rows = await db
    .update(repos)
    .set({ enabled })
    .where(scoped(repos, orgId, eq(repos.id, repoId)))
    .returning({ id: repos.id });
  return rows.length > 0;
}
