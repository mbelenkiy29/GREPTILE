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
      <div className="row">
        <input className="mono" readOnly value={link} size={64} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
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
    <form action={formAction} className="comment stack-sm" data-testid="invite-form">
      <div className="row">
        <label>
          GitHub username or email <input name="target" placeholder="octocat or dev@example.com" autoComplete="off" size={28} />
        </label>
        <label>
          Role{" "}
          <select name="role" defaultValue="member">
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <button className="button button-primary" type="submit" disabled={pending}>
          Create invite link
        </button>
      </div>
      <span className="dim">Naming someone limits the link to that GitHub account or email. Leave it empty for a link anyone can use.</span>
      {state.error && (
        <p className="error-text" role="alert">
          {state.error}
        </p>
      )}
      {state.link && <CopyableLink link={state.link} target={state.target} />}
    </form>
  );
}
