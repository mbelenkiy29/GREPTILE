import { z } from "zod";
import type { RepoSettings } from "@/lib/db/schema";
import { AGENT_IDS, SEVERITIES, type AgentId, type Severity } from "@/lib/engine/types";
import { globMatch } from "@/lib/rules";

export const COMMENT_TYPES = ["logic", "security", "style"] as const;
export type CommentType = (typeof COMMENT_TYPES)[number];
export const STRICTNESS = ["low", "medium", "high"] as const;
export type Strictness = (typeof STRICTNESS)[number];
export const REVIEW_MODE_VALUES = ["fast", "standard", "deep"] as const;
export const COMMENT_STYLES = ["concise", "detailed"] as const;

/** Legacy comment types (R2.2) mapped to the reviewer agents that now cover them (R6.14). */
export const COMMENT_TYPE_CATEGORIES: Record<CommentType, AgentId> = {
  logic: "correctness",
  security: "security",
  style: "rules",
};

const glob = z.string().trim().min(1).max(200);

/**
 * Every review setting (R6.14). Org settings, repo settings, and `openreview.json` share these keys; each layer may
 * set any subset. Unknown keys are rejected so typos surface instead of silently doing nothing.
 */
export const reviewSettingsShape = {
  autoReview: z.boolean(),
  reviewDrafts: z.boolean(),
  targetBranches: z.array(glob).max(50),
  ignoredBranches: z.array(glob).max(50),
  ignore: z.array(glob).max(200),
  maxComments: z.number().int().min(0).max(100),
  minConfidence: z.number().min(0).max(1),
  minSeverity: z.enum(SEVERITIES),
  categories: z.array(z.enum(AGENT_IDS)).min(1),
  commentTypes: z.array(z.enum(COMMENT_TYPES)).min(1),
  model: z.string().trim().min(1).max(200),
  mode: z.enum(REVIEW_MODE_VALUES),
  customInstructions: z.string().trim().max(4000),
  autoReReview: z.boolean(),
  commentStyle: z.enum(COMMENT_STYLES),
  strictness: z.enum(STRICTNESS),
  context: z.array(glob).max(50),
};

export const reviewSettingsSchema = z.object(reviewSettingsShape).partial().strict() satisfies z.ZodType<RepoSettings>;

/** Dashboard-editable review settings for a repo (overridden by openreview.json). */
export const repoSettingsSchema = reviewSettingsSchema;
/** Org-wide defaults (overridden by repo settings and openreview.json). */
export const orgSettingsSchema = reviewSettingsSchema;

export interface EffectiveSettings {
  autoReview: boolean;
  reviewDrafts: boolean;
  targetBranches: string[];
  ignoredBranches: string[];
  ignore: string[];
  maxComments: number;
  minConfidence: number;
  minSeverity: Severity;
  categories: AgentId[];
  model: string | null;
  mode: (typeof REVIEW_MODE_VALUES)[number];
  customInstructions: string | null;
  autoReReview: boolean;
  commentStyle: (typeof COMMENT_STYLES)[number];
  strictness: Strictness;
  context: string[];
}

export type SettingKey = keyof EffectiveSettings;
/** Where an effective value came from; `strictness` = derived from the strictness preset. */
export type SettingSource = "default" | "org" | "repo" | "file" | "strictness";

/** Thresholds each strictness level stands for when they are not set explicitly. */
export const STRICTNESS_PRESETS: Record<Strictness, { minConfidence: number; maxComments: number; minSeverity: Severity }> = {
  low: { minConfidence: 0.8, maxComments: 10, minSeverity: "medium" },
  medium: { minConfidence: 0.4, maxComments: 20, minSeverity: "low" },
  high: { minConfidence: 0.2, maxComments: 40, minSeverity: "low" },
};

export const SETTING_DEFAULTS: EffectiveSettings = {
  autoReview: true,
  reviewDrafts: false,
  targetBranches: [],
  ignoredBranches: [],
  ignore: [],
  ...STRICTNESS_PRESETS.medium,
  categories: [...AGENT_IDS],
  model: null,
  mode: "standard",
  customInstructions: null,
  autoReReview: true,
  commentStyle: "concise",
  strictness: "medium",
  context: [],
};

type Layer = { source: "org" | "repo" | "file"; values: RepoSettings };

/** A layer's category list: explicit `categories`, else its legacy `commentTypes` mapped to agents. */
function layerCategories(values: RepoSettings): AgentId[] | undefined {
  if (values.categories) return [...new Set(values.categories)];
  if (values.commentTypes) return [...new Set(values.commentTypes.map((t) => COMMENT_TYPE_CATEGORIES[t]))];
  return undefined;
}

/**
 * Effective review settings (R6.14): defaults ← org ← repo ← `openreview.json`, key by key, with the layer each value
 * came from. `strictness` is a preset: minConfidence, maxComments and minSeverity follow it unless some layer sets
 * them explicitly (an explicit value from any layer beats the preset).
 */
export function resolveEffectiveSettings(
  org: RepoSettings | null | undefined,
  repo: RepoSettings | null | undefined,
  file: RepoSettings | null | undefined,
): { settings: EffectiveSettings; sources: Record<SettingKey, SettingSource> } {
  const layers: Layer[] = [
    { source: "file" as const, values: file ?? {} },
    { source: "repo" as const, values: repo ?? {} },
    { source: "org" as const, values: org ?? {} },
  ];
  const sources = {} as Record<SettingKey, SettingSource>;
  const pick = <K extends Exclude<SettingKey, "categories">>(key: K, read: (v: RepoSettings) => EffectiveSettings[K] | undefined) => {
    for (const layer of layers) {
      const value = read(layer.values);
      if (value !== undefined) {
        sources[key] = layer.source;
        return value;
      }
    }
    sources[key] = "default";
    return SETTING_DEFAULTS[key];
  };

  const strictness = pick("strictness", (v) => v.strictness);
  const preset = STRICTNESS_PRESETS[strictness];
  const threshold = <K extends "minConfidence" | "maxComments" | "minSeverity">(key: K): EffectiveSettings[K] => {
    const value = pick(key, (v) => v[key] as EffectiveSettings[K] | undefined);
    if (sources[key] !== "default") return value;
    if (sources.strictness !== "default") sources[key] = "strictness";
    return preset[key] as EffectiveSettings[K];
  };

  let categories: AgentId[] = SETTING_DEFAULTS.categories;
  sources.categories = "default";
  for (const layer of layers) {
    const value = layerCategories(layer.values);
    if (value) {
      categories = value;
      sources.categories = layer.source;
      break;
    }
  }

  const settings: EffectiveSettings = {
    autoReview: pick("autoReview", (v) => v.autoReview),
    reviewDrafts: pick("reviewDrafts", (v) => v.reviewDrafts),
    targetBranches: pick("targetBranches", (v) => v.targetBranches),
    ignoredBranches: pick("ignoredBranches", (v) => v.ignoredBranches),
    ignore: pick("ignore", (v) => v.ignore),
    maxComments: threshold("maxComments"),
    minConfidence: threshold("minConfidence"),
    minSeverity: threshold("minSeverity"),
    categories,
    model: pick("model", (v) => v.model),
    mode: pick("mode", (v) => v.mode),
    customInstructions: pick("customInstructions", (v) => (v.customInstructions ? v.customInstructions : undefined)),
    autoReReview: pick("autoReReview", (v) => v.autoReReview),
    commentStyle: pick("commentStyle", (v) => v.commentStyle),
    strictness,
    context: pick("context", (v) => v.context),
  };
  return { settings, sources };
}

/** Webhook-driven triggers obey the automatic-review gates; people asking explicitly bypass them. */
export const AUTOMATIC_TRIGGERS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/**
 * Why a pull request should not be reviewed under these settings, or null to review it (R6.14). Only automatic
 * (webhook) triggers are gated; a manual, mention, API or CLI request always runs. Branch rules are checked only for
 * the branches that are known (a webhook payload may omit them; the job checks again with the PR it fetched).
 */
export function reviewGate(
  settings: EffectiveSettings,
  input: { trigger: string; draft: boolean; baseRef?: string; headRef?: string },
): string | null {
  if (!AUTOMATIC_TRIGGERS.has(input.trigger)) return null;
  if (!settings.autoReview) return "automatic review is turned off";
  if (input.trigger === "synchronize" && !settings.autoReReview) return "automatic re-review on new commits is turned off";
  if (input.draft && !settings.reviewDrafts) return "draft pull requests are not reviewed";
  if (input.baseRef !== undefined && settings.targetBranches.length && !globMatch(settings.targetBranches, input.baseRef)) {
    return `base branch ${input.baseRef} is not a target branch`;
  }
  const ignored = [input.baseRef, input.headRef].find(
    (b): b is string => b !== undefined && settings.ignoredBranches.length > 0 && globMatch(settings.ignoredBranches, b),
  );
  if (ignored !== undefined) return `branch ${ignored} is ignored`;
  return null;
}
