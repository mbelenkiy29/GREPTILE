"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { RULE_CATEGORIES, RULE_CATEGORY_LABEL, RULE_SEVERITIES, RULE_SEVERITY_HELP, type RuleCategory, type RuleSeverity } from "@/lib/rules/catalog";
import { INITIAL_RULE_FORM_STATE, type RuleFormState } from "@/lib/rules/form-state";

export interface RuleFormValues {
  ruleId?: number;
  title: string;
  text: string;
  category: RuleCategory;
  severity: RuleSeverity;
  enabled: boolean;
  instructions: string;
  paths: string[];
  repoId: number | null;
}

export const EMPTY_RULE: RuleFormValues = { title: "", text: "", category: "rules", severity: "medium", enabled: true, instructions: "", paths: [], repoId: null };

interface Preview {
  files: number;
  repos: number;
  sample: string[];
  capped: boolean;
}

function isPreview(v: unknown): v is Preview {
  return !!v && typeof v === "object" && typeof (v as Preview).files === "number" && Array.isArray((v as Preview).sample);
}

/** "Matches N files": asks the preview endpoint (debounced) as the path globs or scope change. */
function PathPreview({ paths, repoId, id }: { paths: string; repoId: string; id: string }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ok" | "error"; preview?: Preview }>({ status: "idle" });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, status: "loading" }));
      const q = new URLSearchParams({ paths });
      if (repoId) q.set("repoId", repoId);
      try {
        const res = await fetch(`/api/rules/preview?${q.toString()}`, { signal: controller.signal, cache: "no-store", credentials: "same-origin" });
        const body: unknown = await res.json();
        setState(res.ok && isPreview(body) ? { status: "ok", preview: body } : { status: "error" });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) setState({ status: "error" });
      }
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [paths, repoId]);

  const p = state.preview;
  return (
    <div className="field-help" id={id} aria-live="polite" data-testid="path-preview">
      {state.status === "error" ? (
        "Couldn't check which files match."
      ) : !p ? (
        "Checking which indexed files match…"
      ) : (
        <>
          {state.status === "loading" ? "Updating… " : ""}
          Matches <strong>{p.capped ? `${p.files.toLocaleString("en-US")}+` : p.files.toLocaleString("en-US")}</strong> indexed file{p.files === 1 ? "" : "s"}
          {p.repos > 1 ? ` across ${p.repos} repositories` : ""}
          {p.sample.length > 0 && (
            <>
              , e.g. <span className="mono break">{p.sample.slice(0, 3).join(", ")}</span>
            </>
          )}
          .
        </>
      )}
    </div>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p className="field-error" id={id} role="alert">
      {error}
    </p>
  );
}

/**
 * Create or edit a rule (R6.11): title, rule text, category, default severity, scope (organization or one
 * repository), path globs with a live matching-files preview, extra instructions, and the on/off switch.
 */
export function RuleForm({
  initial,
  repos,
  action,
  submitLabel,
}: {
  initial: RuleFormValues;
  repos: { id: number; fullName: string }[];
  action: (prev: RuleFormState, formData: FormData) => Promise<RuleFormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_RULE_FORM_STATE);
  const v = state.values;
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const [scope, setScope] = useState<"org" | "repo">(v ? (v.scope === "repo" ? "repo" : "org") : initial.repoId !== null ? "repo" : "org");
  const [repoId, setRepoId] = useState(v?.repoId ?? (initial.repoId !== null ? String(initial.repoId) : ""));
  const [paths, setPaths] = useState(v?.paths ?? initial.paths.join("\n"));
  const [severity, setSeverity] = useState<RuleSeverity>(((v?.severity as RuleSeverity | undefined) ?? initial.severity) || "medium");
  const e = state.errors;
  const described = (k: keyof typeof e, help?: boolean) => [help ? id(`${k}-help`) : null, e[k] ? id(`${k}-error`) : null].filter(Boolean).join(" ") || undefined;

  return (
    <form action={formAction} className="stack-md" noValidate data-testid="rule-form">
      {initial.ruleId !== undefined && <input type="hidden" name="ruleId" value={initial.ruleId} />}
      {state.message && state.status !== "saved" && <Alert tone="error">{state.message}</Alert>}
      <div className="field">
        <label className="field-label" htmlFor={id("title")}>
          Title
        </label>
        <input
          id={id("title")}
          name="title"
          className="input"
          required
          maxLength={120}
          defaultValue={v?.title ?? initial.title}
          placeholder="e.g. API routes must verify organization membership"
          aria-invalid={e.title ? true : undefined}
          aria-describedby={described("title")}
        />
        <FieldError id={id("title-error")} error={e.title} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={id("text")}>
          Rule
        </label>
        <textarea
          id={id("text")}
          name="text"
          className="textarea"
          rows={3}
          required
          maxLength={2000}
          defaultValue={v?.text ?? initial.text}
          placeholder="Write it in plain English, as you'd explain it to a new teammate."
          aria-invalid={e.text ? true : undefined}
          aria-describedby={described("text", true)}
        />
        <p className="field-help" id={id("text-help")}>
          Reviews report violations in changed lines and cite this rule in the comment.
        </p>
        <FieldError id={id("text-error")} error={e.text} />
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label" htmlFor={id("category")}>
            Category
          </label>
          <select id={id("category")} name="category" className="select" defaultValue={v?.category ?? initial.category} aria-describedby={described("category")}>
            {RULE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {RULE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <FieldError id={id("category-error")} error={e.category} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={id("severity")}>
            Severity
          </label>
          <select
            id={id("severity")}
            name="severity"
            className="select"
            value={severity}
            onChange={(ev) => setSeverity(ev.target.value as RuleSeverity)}
            aria-describedby={described("severity", true)}
          >
            {RULE_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <p className="field-help" id={id("severity-help")}>
            {RULE_SEVERITY_HELP[severity]} Findings that cite this rule are at least this severe.
          </p>
          <FieldError id={id("severity-error")} error={e.severity} />
        </div>
      </div>
      <fieldset className="fieldset field" aria-describedby={described("repoId")}>
        <legend className="field-label">Applies to</legend>
        <div className="checks">
          <label className="check">
            <input type="radio" name="scope" value="org" checked={scope === "org"} onChange={() => setScope("org")} />
            <span>Every repository</span>
          </label>
          <label className="check">
            <input type="radio" name="scope" value="repo" checked={scope === "repo"} onChange={() => setScope("repo")} disabled={!repos.length} />
            <span>One repository</span>
          </label>
        </div>
        {scope === "repo" && (
          <select name="repoId" className="select" value={repoId} onChange={(ev) => setRepoId(ev.target.value)} aria-label="Repository" style={{ maxWidth: 420 }}>
            <option value="">Pick a repository…</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        )}
        <FieldError id={id("repoId-error")} error={e.repoId} />
      </fieldset>
      <div className="field">
        <label className="field-label" htmlFor={id("paths")}>
          File patterns
        </label>
        <textarea
          id={id("paths")}
          name="paths"
          className="textarea mono"
          rows={3}
          value={paths}
          onChange={(ev) => setPaths(ev.target.value)}
          placeholder={"src/api/**\n**/*.sql"}
          aria-invalid={e.paths ? true : undefined}
          aria-describedby={[id("paths-help"), id("paths-preview"), e.paths ? id("paths-error") : null].filter(Boolean).join(" ")}
        />
        <p className="field-help" id={id("paths-help")}>
          Globs, one per line. Leave empty to apply the rule to every file.
        </p>
        <PathPreview id={id("paths-preview")} paths={paths} repoId={scope === "repo" ? repoId : ""} />
        <FieldError id={id("paths-error")} error={e.paths} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={id("instructions")}>
          Instructions <span className="dim">(optional)</span>
        </label>
        <textarea
          id={id("instructions")}
          name="instructions"
          className="textarea"
          rows={4}
          maxLength={4000}
          defaultValue={v?.instructions ?? initial.instructions}
          placeholder="Context and examples: what counts as a violation, what doesn't, and how to fix it."
          aria-invalid={e.instructions ? true : undefined}
          aria-describedby={described("instructions")}
        />
        <FieldError id={id("instructions-error")} error={e.instructions} />
      </div>
      <label className="check">
        <input type="checkbox" name="enabled" value="true" defaultChecked={v ? v.enabled !== "false" : initial.enabled} />
        <input type="hidden" name="enabled" value="false" />
        <span>Enabled: enforce this rule in reviews</span>
      </label>
      <div className="form-actions">
        <SubmitButton variant="primary" pendingLabel="Saving…">
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
