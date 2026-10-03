import { and, eq } from "drizzle-orm";
import { CONFIG_FILE, parseRepoConfig } from "@/lib/config/repo-config";
import { orgSettingsSchema, resolveEffectiveSettings, type EffectiveSettings, type SettingKey, type SettingSource } from "@/lib/config/settings";
import type { Db } from "@/lib/db";
import { installations, orgs, repos, type OrgSettings, type RepoSettings } from "@/lib/db/schema";
import type { GitHost } from "@/lib/git/types";
import { errorMessage } from "@/lib/log";
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

export type ConfigFileStatus = "found" | "absent" | "invalid" | "unavailable" | "not_checked";

export interface RepoSettingsView {
  repoSettings: RepoSettings;
  orgSettings: OrgSettings;
  /** Effective values (defaults ← org ← repo ← openreview.json when it could be read) and each value's layer. */
  settings: EffectiveSettings;
  sources: Record<SettingKey, SettingSource>;
  /** The repository's openreview.json on its default branch. */
  file: { status: ConfigFileStatus; message: string | null; settings: RepoSettings | null };
}

/**
 * Everything the repository settings tab shows (R6.14). With a git host, `openreview.json` is read from the default
 * branch (bounded by `timeoutMs`) so values it sets show the "file" source; without a host, or when the read fails,
 * the dashboard layers are shown and the file status says why.
 */
export async function getRepoSettingsView(
  db: Db,
  orgId: string,
  repoId: number,
  opts: { host?: GitHost; timeoutMs?: number } = {},
): Promise<RepoSettingsView | undefined> {
  const [row] = await db
    .select({
      repo: repos.settings,
      org: orgs.settings,
      fullName: repos.fullName,
      defaultBranch: repos.defaultBranch,
      installationExternalId: installations.externalId,
    })
    .from(repos)
    .innerJoin(orgs, eq(repos.orgId, orgs.id))
    .innerJoin(installations, and(eq(installations.id, repos.installationId), eq(installations.orgId, orgId)))
    .where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!row) return undefined;
  let file: RepoSettingsView["file"] = { status: "not_checked", message: null, settings: null };
  if (opts.host) {
    file = await readConfigFile(opts.host, row, opts.timeoutMs ?? 3_000);
  }
  const { settings, sources } = resolveEffectiveSettings(row.org, row.repo, file.settings ?? undefined);
  return { repoSettings: row.repo, orgSettings: row.org, settings, sources, file };
}

async function readConfigFile(
  host: GitHost,
  repo: { installationExternalId: number; fullName: string; defaultBranch: string },
  timeoutMs: number,
): Promise<RepoSettingsView["file"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      host.client(repo.installationExternalId).getFileContent(repo.fullName, CONFIG_FILE, repo.defaultBranch),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
    if (text === null) return { status: "absent", message: null, settings: null };
    const parsed = parseRepoConfig(text);
    if (!parsed.config) return { status: "invalid", message: parsed.error ?? `${CONFIG_FILE} is invalid`, settings: null };
    const settings: Record<string, unknown> = { ...parsed.config };
    delete settings.$schema;
    delete settings.rules;
    return { status: "found", message: null, settings: settings as RepoSettings };
  } catch (err) {
    return { status: "unavailable", message: `Couldn't read ${CONFIG_FILE}: ${errorMessage(err)}`, settings: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
