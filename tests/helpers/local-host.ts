import { completeInstallation } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { LocalGitHost } from "@/lib/git/local/host";
import { initBareRepo, repoDir } from "@/lib/git/local/repo";
import { ensureLocalInstallation } from "@/lib/git/local/store";
import { createTestDb } from "./db";
import { FixtureRepo, tempDir } from "./fixture-repo";

/** Demo mode on, outside production: what the local host requires. */
export const DEMO_ON = { NODE_ENV: "test", DEMO_MODE: true, DEMO_MODE_ALLOW_PRODUCTION: false } as const;

/**
 * A local git host (R6.22) over a fresh database and LOCAL_GIT_ROOT: `publish(fixture, fullName, branches)` pushes a
 * working repository's branches into the bare repository `fullName`, and `connect(owner)` creates the org's local
 * installation and syncs its repositories.
 */
export async function localHostWorld(orgId = "org_a") {
  const db: Db = await createTestDb();
  const root = tempDir("or-local-git-");
  const host = new LocalGitHost({ db, root, mode: DEMO_ON });

  const publish = async (fixture: FixtureRepo, fullName: string, branches: string[], defaultBranch = "main") => {
    const dir = await initBareRepo(root, fullName, defaultBranch);
    fixture.git("-c", "push.negotiate=false", "push", "--quiet", "--force", dir, ...branches.map((b) => `${b}:refs/heads/${b}`));
    return dir;
  };

  const connect = async (owner: string, orgName = "Acme") => {
    const installation = await ensureLocalInstallation(db, { orgId, owner, orgName });
    const { repos } = await completeInstallation(db, host, { orgId, orgName, installationId: installation.externalId });
    return { installation, repos };
  };

  return { db, root, host, publish, connect, dirOf: (fullName: string) => repoDir(root, fullName) };
}
