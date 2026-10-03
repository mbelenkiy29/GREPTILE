import { z } from "zod";
import type { OrgSettings, RepoSettings } from "@/lib/db/schema";
import type { GitClient } from "@/lib/git/types";
import type { ReviewRule } from "@/lib/rules";
import { runtimeValidationSchema, type RuntimeValidationConfig } from "@/lib/sandbox/config";
import {
  COMMENT_TYPES,
  STRICTNESS,
  resolveEffectiveSettings,
  reviewSettingsShape,
  type CommentType,
  type EffectiveSettings,
  type SettingKey,
  type SettingSource,
  type Strictness,
} from "./settings";

export { COMMENT_TYPES, STRICTNESS, type CommentType, type Strictness };

export const CONFIG_FILE = "openreview.json";

const glob = z.string().trim().min(1);

/**
 * Schema of `openreview.json` in a repository root (R2.2): rules plus every review setting (R6.14). Unknown keys are
 * rejected to catch typos.
 */
export const repoConfigSchema = z
  .object({
    $schema: z.string().optional(),
    rules: z
      .array(z.union([z.string().trim().min(5), z.object({ rule: z.string().trim().min(5), paths: z.array(glob).optional() }).strict()]))
      .max(100)
      .optional(),
    ...z.object(reviewSettingsShape).partial().shape,
    /** Runtime validation (R4.5); honoured only from the base commit's file, like every other key. */
    runtimeValidation: runtimeValidationSchema.optional(),
  })
  .strict();

export type RepoConfigFile = z.infer<typeof repoConfigSchema>;

type LegacyKey = "strictness" | "commentTypes" | "ignore" | "context";
type LegacySource = "default" | "dashboard" | "file";

export interface EffectiveConfig {
  strictness: Strictness;
  commentTypes: CommentType[];
  ignore: string[];
  context: string[];
  /** Rules declared in openreview.json, in addition to dashboard rules. */
  rules: ReviewRule[];
  /** Where each legacy setting came from, for display ("dashboard" = org or repo settings). */
  sources: Record<LegacyKey, LegacySource>;
  /** Every effective review setting (R6.14) and the layer it came from. */
  settings: EffectiveSettings;
  settingSources: Record<SettingKey, SettingSource>;
  /** Runtime validation settings (R4.5): `openreview.json` wins over the repo's dashboard settings; null = none. */
  runtimeValidation: RuntimeValidationConfig | null;
  notices: string[];
}

export const DEFAULTS = {
  strictness: "medium" as Strictness,
  commentTypes: [...COMMENT_TYPES] as CommentType[],
  ignore: [] as string[],
  context: [] as string[],
};

export function parseRepoConfig(text: string): { config?: RepoConfigFile; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `${CONFIG_FILE} is not valid JSON (${err instanceof Error ? err.message : "parse error"})` };
  }
  const res = repoConfigSchema.safeParse(raw);
  if (!res.success) {
    const issue = res.error.issues[0]!;
    const where = issue.path.length ? issue.path.join(".") : "(root)";
    return { error: `${CONFIG_FILE}: ${where}: ${issue.message}` };
  }
  return { config: res.data };
}

/** The review-settings part of an `openreview.json` (everything except `$schema` and `rules`). */
function settingsOf(file: RepoConfigFile): RepoSettings {
  const settings: Record<string, unknown> = { ...file };
  delete settings.$schema;
  delete settings.rules;
  delete settings.runtimeValidation;
  return settings as RepoSettings;
}

/**
 * Defaults ← org settings ← repo (dashboard) settings ← openreview.json, key by key: the repo file wins (R2.2,
 * R6.14).
 */
export function resolveConfig(
  dashboard: RepoSettings | null | undefined,
  file: RepoConfigFile | undefined,
  notices: string[] = [],
  org?: OrgSettings | null,
): EffectiveConfig {
  const fileSettings: RepoSettings | undefined = file ? settingsOf(file) : undefined;
  const fileRules = file?.rules;
  const { settings, sources } = resolveEffectiveSettings(org, dashboard, fileSettings);
  const legacy = <K extends LegacyKey>(key: K): { value: NonNullable<RepoSettings[K]>; source: LegacySource } => {
    if (file?.[key] !== undefined) return { value: file[key]!, source: "file" };
    if (dashboard?.[key] !== undefined) return { value: dashboard[key]!, source: "dashboard" };
    if (org?.[key] !== undefined) return { value: org[key]!, source: "dashboard" };
    return { value: DEFAULTS[key] as NonNullable<RepoSettings[K]>, source: "default" };
  };
  const commentTypes = legacy("commentTypes");
  const rules: ReviewRule[] = (fileRules ?? []).map((r, i) =>
    typeof r === "string"
      ? { id: `config:${i + 1}`, text: r, paths: [], scope: "config" }
      : { id: `config:${i + 1}`, text: r.rule, paths: r.paths ?? [], scope: "config" },
  );
  return {
    strictness: settings.strictness,
    commentTypes: commentTypes.value,
    ignore: settings.ignore,
    context: settings.context,
    rules,
    sources: {
      strictness: legacy("strictness").source,
      commentTypes: commentTypes.source,
      ignore: legacy("ignore").source,
      context: legacy("context").source,
    },
    settings,
    settingSources: sources,
    runtimeValidation: file?.runtimeValidation ?? dashboard?.runtimeValidation ?? null,
    notices,
  };
}

/**
 * Loads the effective config for a review. `openreview.json` is read from the PR's
 * base commit, so a PR cannot weaken its own review by editing the file.
 * An invalid file is reported and ignored (dashboard settings apply).
 */
export async function loadEffectiveConfig(
  client: GitClient,
  repo: string,
  ref: string,
  dashboard: RepoSettings | null | undefined,
  org?: OrgSettings | null,
): Promise<EffectiveConfig> {
  const text = await client.getFileContent(repo, CONFIG_FILE, ref);
  if (text === null) return resolveConfig(dashboard, undefined, [], org);
  const { config, error } = parseRepoConfig(text);
  return resolveConfig(dashboard, config, error ? [`${error}. Using dashboard settings instead.`] : [], org);
}
