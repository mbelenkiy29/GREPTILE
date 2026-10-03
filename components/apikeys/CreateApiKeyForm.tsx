"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import type { CreateKeyState } from "@/app/dashboard/settings/api-keys/actions";

export interface ScopeOption {
  value: string;
  label: string;
}

/**
 * Creates an API key (R6.18): name, scopes, and expiry. The new token is shown once, with a copy button; it cannot
 * be shown again after the page is left.
 */
export function CreateApiKeyForm({
  action,
  scopes,
  expiryOptions,
}: {
  action: (prev: CreateKeyState, formData: FormData) => Promise<CreateKeyState>;
  scopes: readonly ScopeOption[];
  expiryOptions: readonly { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <div className="stack-md">
      {state.token && (
        <div className="notice stack-sm" role="status" data-testid="new-api-key">
          <span>
            <strong>{state.name}</strong> created. Copy the key now: it is shown only once and OpenReview stores only its hash.
          </span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              className="input mono"
              readOnly
              value={state.token}
              aria-label="New API key"
              onFocus={(e) => e.currentTarget.select()}
              style={{ minWidth: 0 }}
            />
            <CopyButton value={state.token} label="Copy key" />
          </div>
        </div>
      )}
      <form action={formAction} className="stack-md" data-testid="create-api-key">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "1 1 260px" }}>
            <label className="field-label" htmlFor="key-name">
              Name
            </label>
            <input id="key-name" className="input" name="name" placeholder="CI pipeline" maxLength={100} required autoComplete="off" />
          </div>
          <div className="field" style={{ flex: "0 1 180px" }}>
            <label className="field-label" htmlFor="key-expiry">
              Expires
            </label>
            <select id="key-expiry" className="select" name="expiresInDays" defaultValue={expiryOptions[1]?.value ?? ""}>
              {expiryOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Scopes</legend>
          <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
            {scopes.map((s) => (
              <label key={s.value} className="check">
                <input type="checkbox" name="scopes" value={s.value} defaultChecked={s.value.endsWith(":read")} />
                <span>
                  <span className="mono">{s.value}</span> <span className="dim">· {s.label}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {state.error && (
          <p className="field-error" role="alert">
            {state.error}
          </p>
        )}
        <div>
          <button className="button button-primary" type="submit" disabled={pending} aria-busy={pending || undefined}>
            {pending && <span className="spinner" aria-hidden="true" />}
            Create API key
          </button>
        </div>
      </form>
    </div>
  );
}
