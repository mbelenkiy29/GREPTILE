/**
 * The repository review-settings form (R6.14): turns the dashboard form into a validated `RepoSettings` layer, and
 * saves it with the role check. An empty field means "inherit" (the org default or the built-in default), so the
 * repo layer only stores what the form sets explicitly.
 */
import { can, type Role } from "@/lib/auth/permissions";
import type { Db } from "@/lib/db";
import type { RepoSettings } from "@/lib/db/schema";
import { getRepo, updateRepoSettings } from "@/lib/data/installations";
import { getOrgSettings, updateOrgSettings } from "@/lib/data/settings";
import { AGENT_IDS } from "@/lib/engine/types";
import { repoSettingsSchema, type SettingKey } from "./settings";
import type { SettingsFormErrors, SettingsFormState } from "./settings-form-state";

export { INITIAL_SETTINGS_FORM_STATE, type SettingsFormErrors, type SettingsFormState } from "./settings-form-state";

const BOOLEAN_KEYS = ["autoReview", "reviewDrafts", "autoReReview"] as const;
const LIST_KEYS = ["targetBranches", "ignoredBranches", "ignore", "context"] as const;
const CHOICE_KEYS = ["minSeverity", "mode", "commentStyle", "strictness"] as const;
const TEXT_KEYS = ["model", "customInstructions"] as const;

function text(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Reads the settings form. Booleans and choices are selects whose empty option means inherit; lists are textareas
 * (one glob per line, empty = inherit); numbers are inputs (empty = inherit); categories inherit unless
 * `categoriesMode=custom`, in which case the checked `categories` are stored.
 */
export function readSettingsForm(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BOOLEAN_KEYS) {
    const v = text(form, key);
    if (v === "true" || v === "false") out[key] = v === "true";
    else if (v !== "") out[key] = v;
  }
  for (const key of LIST_KEYS) {
    const v = lines(text(form, key));
    if (v.length) out[key] = v;
  }
  for (const key of CHOICE_KEYS) {
    const v = text(form, key).trim();
    if (v) out[key] = v;
  }
  for (const key of TEXT_KEYS) {
    const v = text(form, key).trim();
    if (v) out[key] = v;
  }
  const maxComments = text(form, "maxComments").trim();
  if (maxComments) out.maxComments = Number(maxComments);
  const minConfidence = text(form, "minConfidence").trim();
  if (minConfidence) out.minConfidence = Number(minConfidence);
  if (text(form, "categoriesMode") === "custom") {
    out.categories = form.getAll("categories").map(String);
  }
  return out;
}

const MESSAGES: Partial<Record<SettingKey, string>> = {
  maxComments: "Enter a whole number from 0 to 100.",
  minConfidence: "Enter a number from 0 to 1, e.g. 0.6.",
  categories: `Choose at least one category (${AGENT_IDS.join(", ")}).`,
  targetBranches: "Enter at most 50 branch patterns, one per line, each up to 200 characters.",
  ignoredBranches: "Enter at most 50 branch patterns, one per line, each up to 200 characters.",
  ignore: "Enter at most 200 path patterns, one per line, each up to 200 characters.",
  context: "Enter at most 50 paths or patterns, one per line, each up to 200 characters.",
  customInstructions: "Keep custom instructions under 4,000 characters.",
  model: "Model ids are at most 200 characters.",
};

function submittedValues(form: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const all = form.getAll(key).filter((v): v is string => typeof v === "string");
    out[key] = key === "categories" ? all : (all[0] ?? "");
  }
  // Unchecked boxes are absent from the form; an empty list keeps them unchecked when the form is shown again.
  out.categories ??= [];
  return out;
}

/** Validates the form into a repo settings layer, or field errors. */
export function parseSettingsForm(form: FormData): { settings: RepoSettings; errors?: undefined } | { settings?: undefined; errors: SettingsFormErrors } {
  const parsed = repoSettingsSchema.safeParse(readSettingsForm(form));
  if (parsed.success) return { settings: parsed.data };
  const errors: SettingsFormErrors = {};
  for (const issue of parsed.error.issues) {
    const key = (issue.path[0] as SettingKey | undefined) ?? "form";
    errors[key] ??= (key !== "form" && MESSAGES[key]) || issue.message;
  }
  return { errors };
}

/**
 * The server-action body behind "Save settings": checks the caller's role, validates, and replaces the repo's
 * dashboard settings layer. `ctx` comes from the session (never from the form); the repo must belong to `ctx.orgId`.
 */
export async function saveRepoSettingsForm(db: Db, ctx: { orgId: string; role: Role }, form: FormData): Promise<SettingsFormState> {
  if (!can(ctx.role, "settings.manage")) {
    return { status: "forbidden", errors: {}, message: "Only owners and admins can change review settings." };
  }
  const repoId = Number(text(form, "repoId"));
  const repo = Number.isSafeInteger(repoId) ? await getRepo(db, ctx.orgId, repoId) : undefined;
  if (!repo) return { status: "not_found", errors: {}, message: "That repository isn't connected to this organization." };
  const result = parseSettingsForm(form);
  if (result.errors) return { status: "invalid", errors: result.errors, message: "Some settings need attention.", values: submittedValues(form) };
  await updateRepoSettings(db, ctx.orgId, repo.id, result.settings);
  return { status: "saved", errors: {}, message: "Settings saved." };
}

/**
 * The server-action body behind the org review defaults (R6.14, R6.2): checks the caller's role, validates, and
 * saves `orgs.settings` for `ctx.orgId`. The full Settings form replaces the org layer (an empty field removes the
 * key); the onboarding wizard sends only some fields and `merge`s them into the existing layer.
 */
export async function saveOrgSettingsForm(
  db: Db,
  ctx: { orgId: string; role: Role },
  form: FormData,
  opts: { merge?: boolean } = {},
): Promise<SettingsFormState> {
  if (!can(ctx.role, "settings.manage")) {
    return { status: "forbidden", errors: {}, message: "Only owners and admins can change review defaults." };
  }
  const result = parseSettingsForm(form);
  if (result.errors) return { status: "invalid", errors: result.errors, message: "Some settings need attention.", values: submittedValues(form) };
  const next = opts.merge ? { ...((await getOrgSettings(db, ctx.orgId)) ?? {}), ...result.settings } : result.settings;
  const saved = await updateOrgSettings(db, ctx.orgId, next);
  if (!saved) return { status: "not_found", errors: {}, message: "This organization no longer exists." };
  return { status: "saved", errors: {}, message: "Review defaults saved." };
}
