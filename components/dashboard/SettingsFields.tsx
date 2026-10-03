import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Field } from "@/components/ui/Field";
import { COMMENT_STYLES, REVIEW_MODE_VALUES, STRICTNESS, type EffectiveSettings, type SettingKey, type SettingSource } from "@/lib/config/settings";
import type { SettingsFormErrors } from "@/lib/config/settings-form-state";
import type { RepoSettings } from "@/lib/db/schema";
import { AGENT_IDS, SEVERITIES } from "@/lib/engine/types";

const SOURCE_LABEL: Record<SettingSource, string> = {
  default: "Default",
  org: "Org",
  repo: "Repo",
  file: "openreview.json",
  strictness: "Strictness preset",
};
const SOURCE_TONE = { default: "muted", org: "info", repo: "accent", file: "warn", strictness: "outline" } as const;
const SOURCE_HELP: Record<SettingSource, string> = {
  default: "Built-in default",
  org: "Set in the organization's defaults",
  repo: "Set for this repository",
  file: "Set in openreview.json on the default branch (overrides the dashboard)",
  strictness: "Follows the strictness preset",
};

/** Where an effective setting comes from: default, org, repo, the repo's openreview.json, or the strictness preset. */
export function SourceBadge({ source }: { source: SettingSource }) {
  return (
    <span data-source={source}>
      <Badge tone={SOURCE_TONE[source]} title={SOURCE_HELP[source]}>
        {SOURCE_LABEL[source]}
      </Badge>
    </span>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  correctness: "Correctness",
  security: "Security",
  data: "Data & migrations",
  api_compat: "API compatibility",
  testing: "Testing",
  performance: "Performance",
  rules: "Custom rules",
};

const onOff = (v: boolean) => (v ? "On" : "Off");

export interface SettingsFieldsProps {
  /** Effective values and their sources. */
  settings: EffectiveSettings;
  sources: Record<SettingKey, SettingSource>;
  /** What applies when the repo leaves a key unset (org ← defaults). */
  inherited: EffectiveSettings;
  /** The repo's own layer (form defaults). */
  repoSettings: RepoSettings;
  errors?: SettingsFormErrors;
  /** Submitted values to show again after a failed save. */
  values?: Record<string, string | string[]>;
}

/**
 * Every R6.14 review setting as a form control with its effective value's source badge. Empty fields inherit; the
 * form stores only what is set for this repository.
 */
export function SettingsFields({ settings, sources, inherited, repoSettings, errors = {}, values }: SettingsFieldsProps) {
  const str = (key: string, fromRepo: string): string => {
    if (!values) return fromRepo;
    const v = values[key];
    return Array.isArray(v) ? v.join("\n") : (v ?? "");
  };
  const boolValue = (key: "autoReview" | "reviewDrafts" | "autoReReview") => str(key, repoSettings[key] === undefined ? "" : String(repoSettings[key]));
  const listValue = (key: "targetBranches" | "ignoredBranches" | "ignore" | "context") => str(key, (repoSettings[key] ?? []).join("\n"));
  const repoCategories = repoSettings.categories ?? (repoSettings.commentTypes ? settings.categories : undefined);
  const categoriesMode = values ? str("categoriesMode", "") : repoCategories ? "custom" : "inherit";
  const checkedCategories = new Set(values ? ((values.categories as string[] | undefined) ?? []) : (repoCategories ?? inherited.categories));

  const id = (k: string) => `setting-${k}`;
  const describe = (k: string, help: boolean) => [help ? `${id(k)}-help` : null, errors[k as SettingKey] ? `${id(k)}-error` : null].filter(Boolean).join(" ") || undefined;
  const chrome = (k: SettingKey, label: string, help: ReactNode) => ({
    id: id(k),
    label,
    help,
    error: errors[k],
    adornment: <SourceBadge source={sources[k]} />,
  });

  const boolField = (k: "autoReview" | "reviewDrafts" | "autoReReview", label: string, help: string) => (
    <Field {...chrome(k, label, help)}>
      <select id={id(k)} name={k} className="select" defaultValue={boolValue(k)} aria-invalid={errors[k] ? true : undefined} aria-describedby={describe(k, true)}>
        <option value="">Inherit ({onOff(inherited[k])})</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    </Field>
  );
  const choiceField = <K extends "mode" | "strictness" | "minSeverity" | "commentStyle">(k: K, label: string, help: string, options: readonly string[]) => (
    <Field {...chrome(k, label, help)}>
      <select id={id(k)} name={k} className="select" defaultValue={str(k, repoSettings[k] ?? "")} aria-invalid={errors[k] ? true : undefined} aria-describedby={describe(k, true)}>
        <option value="">Inherit ({String(inherited[k])})</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Field>
  );
  const listField = (k: "targetBranches" | "ignoredBranches" | "ignore" | "context", label: string, help: string, placeholder: string) => (
    <Field {...chrome(k, label, help)}>
      <textarea
        id={id(k)}
        name={k}
        className="textarea mono"
        rows={3}
        defaultValue={listValue(k)}
        placeholder={inherited[k].length ? `Inherit:\n${inherited[k].join("\n")}` : placeholder}
        aria-invalid={errors[k] ? true : undefined}
        aria-describedby={describe(k, true)}
      />
    </Field>
  );

  return (
    <div className="form-grid">
      <section className="form-section" aria-labelledby="sec-when">
        <div className="form-section-head">
          <h3 id="sec-when">When to review</h3>
          <p className="dim">Which pull requests get reviewed automatically. Asking for a review from the dashboard, a comment, or the API always runs.</p>
        </div>
        <div className="form-row">
          {boolField("autoReview", "Automatic review", "Review pull requests when they're opened or reopened.")}
          {boolField("autoReReview", "Re-review on new commits", "Review again (incrementally) when commits are pushed.")}
          {boolField("reviewDrafts", "Review drafts", "Also review draft pull requests.")}
        </div>
        <div className="form-row">
          {listField("targetBranches", "Target branches", "Base branches to review (globs, one per line). Empty means all.", "main\nrelease/*")}
          {listField("ignoredBranches", "Ignored branches", "Skip pull requests whose head or base matches (globs, one per line).", "dependabot/**")}
        </div>
      </section>

      <section className="form-section" aria-labelledby="sec-what">
        <div className="form-section-head">
          <h3 id="sec-what">What to review</h3>
          <p className="dim">Paths to skip, the reviewers that run, and files every review should read.</p>
        </div>
        {listField("ignore", "Ignored paths", "Files never reviewed (globs, one per line).", "**/generated/**\n*.lock")}
        <fieldset className="fieldset field" data-field={id("categories")} aria-describedby={describe("categories", true)}>
          <legend className="field-label">
            Categories <SourceBadge source={sources.categories} />
          </legend>
          <select
            name="categoriesMode"
            className="select"
            defaultValue={categoriesMode}
            aria-label="Category selection"
            style={{ maxWidth: 320 }}
          >
            <option value="inherit">Inherit ({inherited.categories.length === AGENT_IDS.length ? "all" : inherited.categories.join(", ")})</option>
            <option value="custom">Only the categories checked below</option>
          </select>
          <div className="checks">
            {AGENT_IDS.map((c) => (
              <label key={c} className="check">
                <input type="checkbox" name="categories" value={c} defaultChecked={checkedCategories.has(c)} />
                <span>{CATEGORY_LABEL[c] ?? c}</span>
              </label>
            ))}
          </div>
          <p className="field-help" id={`${id("categories")}-help`}>
            Each category is a specialized reviewer. Checked boxes apply when “Only the categories checked below” is selected.
          </p>
          {errors.categories && (
            <p className="field-error" id={`${id("categories")}-error`} role="alert">
              {errors.categories}
            </p>
          )}
        </fieldset>
        {listField("context", "Context files", "Always included in reviews (paths or globs, one per line).", "CONTRIBUTING.md\ndocs/adr/*.md")}
      </section>

      <section className="form-section" aria-labelledby="sec-how">
        <div className="form-section-head">
          <h3 id="sec-how">How to comment</h3>
          <p className="dim">Depth, thresholds, and tone. Strictness presets the thresholds unless you set them explicitly.</p>
        </div>
        <div className="form-row">
          {choiceField("mode", "Review mode", "Fast is cheapest; deep reads more context with a stronger model.", REVIEW_MODE_VALUES)}
          {choiceField("strictness", "Strictness", "Low comments only on clear problems; high flags more.", STRICTNESS)}
          {choiceField("commentStyle", "Comment style", "Concise comments or detailed explanations.", COMMENT_STYLES)}
        </div>
        <div className="form-row">
          {choiceField("minSeverity", "Minimum severity", "Findings below this severity aren't posted.", SEVERITIES)}
          <Field {...chrome("minConfidence", "Minimum confidence", `0 to 1. Currently ${settings.minConfidence}.`)}>
            <input
              id={id("minConfidence")}
              name="minConfidence"
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              max={1}
              step={0.05}
              defaultValue={str("minConfidence", repoSettings.minConfidence === undefined ? "" : String(repoSettings.minConfidence))}
              placeholder={`Inherit (${inherited.minConfidence})`}
              aria-invalid={errors.minConfidence ? true : undefined}
              aria-describedby={describe("minConfidence", true)}
            />
          </Field>
          <Field {...chrome("maxComments", "Max comments", `Per review, 0 to 100. Currently ${settings.maxComments}.`)}>
            <input
              id={id("maxComments")}
              name="maxComments"
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              defaultValue={str("maxComments", repoSettings.maxComments === undefined ? "" : String(repoSettings.maxComments))}
              placeholder={`Inherit (${inherited.maxComments})`}
              aria-invalid={errors.maxComments ? true : undefined}
              aria-describedby={describe("maxComments", true)}
            />
          </Field>
        </div>
      </section>

      <section className="form-section" aria-labelledby="sec-model">
        <div className="form-section-head">
          <h3 id="sec-model">Model and instructions</h3>
          <p className="dim">Pin a model for this repository and tell reviewers what matters here.</p>
        </div>
        <Field {...chrome("model", "Model", "A model id your configured provider serves. Empty uses the deployment's routing.")}>
          <input
            id={id("model")}
            name="model"
            className="input mono"
            defaultValue={str("model", repoSettings.model ?? "")}
            placeholder={inherited.model ? `Inherit (${inherited.model})` : "Deployment default"}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.model ? true : undefined}
            aria-describedby={describe("model", true)}
          />
        </Field>
        <Field {...chrome("customInstructions", "Custom instructions", "Plain-English guidance added to every review of this repository (up to 4,000 characters).")}>
          <textarea
            id={id("customInstructions")}
            name="customInstructions"
            className="textarea"
            rows={5}
            maxLength={4000}
            defaultValue={str("customInstructions", repoSettings.customInstructions ?? "")}
            placeholder={inherited.customInstructions ? `Inherit: ${inherited.customInstructions}` : "e.g. Money is always integer cents. Flag any float arithmetic on prices."}
            aria-invalid={errors.customInstructions ? true : undefined}
            aria-describedby={describe("customInstructions", true)}
          />
        </Field>
      </section>
    </div>
  );
}
