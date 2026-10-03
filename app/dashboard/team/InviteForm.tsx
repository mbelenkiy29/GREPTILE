"use client";

import { useActionState, useState } from "react";

export interface InviteFormState {
  link?: string;
  target?: string | null;
  error?: string;
}

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
] as const;

function CopyableLink({ link, target }: { link: string; target: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice stack-sm" role="status">
      <span>
        Invitation created{target ? ` for ${target}` : ""}. Share this link; it is shown only once and expires in 7 days.
      </span>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input className="input mono" readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} style={{ minWidth: 0 }} />
        <button
          className="button"
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              // Clipboard access is unavailable on insecure origins; the field stays selectable for manual copying.
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

/** Invite by GitHub login or email; shows a copyable `/invite/<token>` link (no email infrastructure needed). */
export function InviteForm({ action }: { action: (prev: InviteFormState, formData: FormData) => Promise<InviteFormState> }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="card card-body" data-testid="invite-form">
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "1 1 240px" }}>
          <label className="field-label" htmlFor="invite-target">
            GitHub username or email
          </label>
          <input id="invite-target" className="input" name="target" placeholder="octocat or dev@example.com" autoComplete="off" />
        </div>
        <div className="field" style={{ flex: "0 1 160px" }}>
          <label className="field-label" htmlFor="invite-role">
            Role
          </label>
          <select id="invite-role" className="select" name="role" defaultValue="member">
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <button className="button button-primary" type="submit" disabled={pending} aria-busy={pending || undefined}>
          {pending && <span className="spinner" aria-hidden="true" />}
          Create invite link
        </button>
      </div>
      <span className="dim">Naming someone limits the link to that GitHub account or email. Leave it empty for a link anyone can use.</span>
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      {state.link && <CopyableLink link={state.link} target={state.target} />}
    </form>
  );
}
