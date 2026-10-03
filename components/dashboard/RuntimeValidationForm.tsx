import type { RuntimeValidationConfig } from "@/lib/db/schema";

/**
 * Repo settings for runtime validation (R4.5, beta): whether to run the repository's tests in the sandbox, and how.
 * A `runtimeValidation` block in the base branch's openreview.json takes precedence over these values.
 */
export function RuntimeValidationForm({
  repoId,
  value,
  fromFile,
  serverEnabled,
  editable,
  returnTo,
  action,
}: {
  repoId: number;
  /** The repo settings layer's value. */
  value: RuntimeValidationConfig | undefined;
  /** openreview.json sets runtimeValidation (it wins). */
  fromFile: boolean;
  /** RUNTIME_VALIDATION_ENABLED on this deployment. */
  serverEnabled: boolean;
  editable: boolean;
  returnTo: string;
  action: (form: FormData) => Promise<void>;
}) {
  const envText = Object.entries(value?.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return (
    <form action={action} className="stack-md" aria-labelledby="runtime-validation-settings">
      <input type="hidden" name="repoId" value={repoId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <div className="stack-sm">
        <h2 id="runtime-validation-settings">Runtime validation (beta)</h2>
        <p className="dim">
          Run this repository&apos;s tests on the pull request head in an isolated container (no network by default, no secrets, CPU, memory and time
          limits). Failures are attached to the review summary.
          {!serverEnabled && " Runtime validation is turned off on this server (RUNTIME_VALIDATION_ENABLED), so these settings have no effect yet."}
          {fromFile && " This repository's openreview.json sets runtimeValidation on the base branch, which takes precedence over these values."}
        </p>
      </div>
      <fieldset className="stack-md" disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="check">
          <input type="checkbox" name="enabled" value="true" defaultChecked={value?.enabled ?? false} />
          <span>Run the tests for every review</span>
        </label>
        <div className="field">
          <label className="field-label" htmlFor="rv-test">
            Test command
          </label>
          <input id="rv-test" name="test" className="mono" defaultValue={value?.test ?? ""} placeholder="npm test -- --reporter=dot" maxLength={2000} />
          <span className="field-help">Runs as sh -c inside the container, in the checked-out pull request.</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rv-install">
            Install command (optional)
          </label>
          <input id="rv-install" name="install" className="mono" defaultValue={value?.install ?? ""} placeholder="npm ci" maxLength={2000} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label className="field-label" htmlFor="rv-image">
              Image (optional)
            </label>
            <input id="rv-image" name="image" className="mono" defaultValue={value?.image ?? ""} placeholder="node:22-bookworm-slim" maxLength={255} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="rv-timeout">
              Time limit in seconds (optional)
            </label>
            <input id="rv-timeout" name="timeoutSec" type="number" min={10} max={7200} defaultValue={value?.timeoutSec ?? ""} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rv-network">
            Network
          </label>
          <select id="rv-network" name="network" defaultValue={value?.network ?? "none"}>
            <option value="none">None (offline install)</option>
            <option value="install-only">Install step through the registry proxy</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rv-env">
            Environment (optional)
          </label>
          <textarea id="rv-env" name="env" className="mono" defaultValue={envText} placeholder={"CI=true\nNODE_ENV=test"} />
          <span className="field-help">One KEY=value per line. Never put secrets here: the values are visible to the code under test.</span>
        </div>
        {editable && (
          <div>
            <button className="button button-primary" type="submit">
              Save runtime validation
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
