/**
 * The demo's system org (R3.7). Demo indexes and results are tenant data like any other, owned by `org_demo`, which
 * has no members (nobody can sign in to it) and one placeholder installation (provider `public-demo`) that repos are
 * attached to. Nothing ever uses that installation to call a git host.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { installations, orgs, repos } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import type { PublicRepo } from "./github";

import { DEMO_ORG_ID, DEMO_PROVIDER } from "./ids";

export { DEMO_ORG_ID, DEMO_PROVIDER };

/** Creates the demo org and its placeholder installation if needed; returns the installation id. */
export async function ensureDemoOrg(db: Db): Promise<number> {
  await db.insert(orgs).values({ id: DEMO_ORG_ID, name: "Public demo", slug: "openreview-public-demo" }).onConflictDoNothing();
  await db
    .insert(installations)
    .values({ orgId: DEMO_ORG_ID, provider: DEMO_PROVIDER, externalId: 0, accountLogin: "github-public", accountType: "Organization", repositorySelection: "selected" })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: installations.id })
    .from(installations)
    .where(and(eq(installations.provider, DEMO_PROVIDER), eq(installations.externalId, 0), eq(installations.orgId, DEMO_ORG_ID)));
  if (!row) throw new Error("the demo installation could not be created");
  return row.id;
}

/** The demo org's repo row for a public GitHub repository (keyed by its GitHub id), created on first use. */
export async function demoRepo(db: Db, installationId: number, gh: PublicRepo) {
  const [row] = await db
    .insert(repos)
    .values({ orgId: DEMO_ORG_ID, installationId, externalId: gh.id, fullName: gh.full_name, defaultBranch: gh.default_branch, private: false })
    .onConflictDoUpdate({ target: [repos.installationId, repos.externalId], set: { fullName: gh.full_name, defaultBranch: gh.default_branch, updatedAt: new Date() } })
    .returning();
  return row!;
}

/** Re-reads a demo repo row (after indexing). */
export async function getDemoRepo(db: Db, repoId: number) {
  const [row] = await db.select().from(repos).where(scoped(repos, DEMO_ORG_ID, eq(repos.id, repoId)));
  return row;
}
