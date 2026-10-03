import { eq } from "drizzle-orm";
import { orgSettingsSchema, resolveEffectiveSettings, type EffectiveSettings, type SettingKey, type SettingSource } from "@/lib/config/settings";
import type { Db } from "@/lib/db";
import { orgs, repos, type OrgSettings } from "@/lib/db/schema";
import { scoped } from "./tenant";

/** Org-wide review defaults (R6.14). */
export async function getOrgSettings(db: Db, orgId: string): Promise<OrgSettings | undefined> {
  if (!orgId) throw new Error("tenant scope requires an orgId");
  const [row] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  return row?.settings;
}

/** Validated replacement of an org's review defaults. Returns undefined when the org does not exist. */
export async function updateOrgSettings(db: Db, orgId: string, settings: OrgSettings): Promise<OrgSettings | undefined> {
  if (!orgId) throw new Error("tenant scope requires an orgId");
  const parsed = orgSettingsSchema.parse(settings);
  const [row] = await db.update(orgs).set({ settings: parsed }).where(eq(orgs.id, orgId)).returning({ settings: orgs.settings });
  return row?.settings;
}

/**
 * A repo's effective dashboard settings (org ← repo) with the layer each value came from, for the settings UI. A
 * repository's `openreview.json` may still override them at review time.
 */
export async function getRepoEffectiveSettings(
  db: Db,
  orgId: string,
  repoId: number,
): Promise<{ settings: EffectiveSettings; sources: Record<SettingKey, SettingSource> } | undefined> {
  const [row] = await db
    .select({ repo: repos.settings, org: orgs.settings })
    .from(repos)
    .innerJoin(orgs, eq(repos.orgId, orgs.id))
    .where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!row) return undefined;
  return resolveEffectiveSettings(row.org, row.repo, undefined);
}
