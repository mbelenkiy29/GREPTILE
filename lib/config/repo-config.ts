import { z } from "zod";
import type { RepoSettings } from "@/lib/db/schema";
import type { GitClient } from "@/lib/git/types";
import type { ReviewRule } from "@/lib/rules";

export const CONFIG_FILE = "tracewise.json";
export const COMMENT_TYPES = ["logic", "security", "style"] as const;
export const STRICTNESS = ["low", "medium", "high"] as const;
export type Strictness = (typeof STRICTNESS)[number];
export type CommentType = (typeof COMMENT_TYPES)[number];

const glob = z.string().trim().min(1);

/** Schema of `tracewise.json` in a repository root (R2.2). Unknown keys are rejected to catch typos. */
export const repoConfigSchema = z
  .object({
    $schema: z.string().optional(),
    rules: z
      .array(z.union([z.string().trim().min(5), z.object({ rule: z.string().trim().min(5), paths: z.array(glob).optional() }).strict()]))
      .max(100)
      .optional(),
    ignore: z.array(glob).max(200).optional(),
    strictness: z.enum(STRICTNESS).optional(),
    commentTypes: z.array(z.enum(COMMENT_TYPES)).min(1).optional(),
    /** Docs (paths or globs) always included as review context (R2.3). */
    context: z.array(glob).max(50).optional(),
  })
  .strict();

export type RepoConfigFile = z.infer<typeof repoConfigSchema>;

export interface EffectiveConfig {
  strictness: Strictness;
  commentTypes: CommentType[];
  ignore: string[];
  context: string[];
  /** Rules declared in tracewise.json, in addition to dashboard rules. */
  rules: ReviewRule[];
  /** Where each setting came from, for display. */
  sources: Record<"strictness" | "commentTypes" | "ignore" | "context", "default" | "dashboard" | "file">;
  notices: string[];
}

export const DEFAULTS = {
  strictness: "medium" as Strictness,
  commentTypes: [...COMMENT_TYPES] as CommentType[],
  ignore: [] as string[],
  context: [] as string[],
};

/** Review thresholds each strictness level maps to. */
export const STRICTNESS_LEVELS: Record<Strictness, { minConfidence: number; maxComments: number; minSeverity: "low" | "medium" | "high" }> = {
  low: { minConfidence: 4, maxComments: 10, minSeverity: "medium" },
  medium: { minConfidence: 2, maxComments: 20, minSeverity: "low" },
  high: { minConfidence: 1, maxComments: 40, minSeverity: "low" },
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

/** Defaults ← dashboard settings ← tracewise.json, key by key: the repo file wins. */
export function resolveConfig(dashboard: RepoSettings | null | undefined, file: RepoConfigFile | undefined, notices: string[] = []): EffectiveConfig {
  const pick = <K extends "strictness" | "commentTypes" | "ignore" | "context">(key: K) => {
    if (file?.[key] !== undefined) return { value: file[key]!, source: "file" as const };
    if (dashboard?.[key] !== undefined) return { value: dashboard[key]!, source: "dashboard" as const };
    return { value: DEFAULTS[key], source: "default" as const };
  };
  const strictness = pick("strictness");
  const commentTypes = pick("commentTypes");
  const ignore = pick("ignore");
  const context = pick("context");
  const rules: ReviewRule[] = (file?.rules ?? []).map((r, i) =>
    typeof r === "string"
      ? { id: `config:${i + 1}`, text: r, paths: [], scope: "config" }
      : { id: `config:${i + 1}`, text: r.rule, paths: r.paths ?? [], scope: "config" },
  );
  return {
    strictness: strictness.value as Strictness,
    commentTypes: commentTypes.value as CommentType[],
    ignore: ignore.value as string[],
    context: context.value as string[],
    rules,
    sources: { strictness: strictness.source, commentTypes: commentTypes.source, ignore: ignore.source, context: context.source },
    notices,
  };
}

/**
 * Loads the effective config for a review. `tracewise.json` is read from the PR's
 * base commit, so a PR cannot weaken its own review by editing the file.
 * An invalid file is reported and ignored (dashboard settings apply).
 */
export async function loadEffectiveConfig(
  client: GitClient,
  repo: string,
  ref: string,
  dashboard: RepoSettings | null | undefined,
): Promise<EffectiveConfig> {
  const text = await client.getFileContent(repo, CONFIG_FILE, ref);
  if (text === null) return resolveConfig(dashboard, undefined);
  const { config, error } = parseRepoConfig(text);
  return resolveConfig(dashboard, config, error ? [`${error}. Using dashboard settings instead.`] : []);
}
