"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { SubmitButton } from "@/components/ui/SubmitButton";

export interface InviteLinkState {
  link?: string;
  error?: string;
}

/**
 * "Copy link" for a pending invitation. Only a hash of the link is stored, so this makes a fresh link (the old one
 * stops working, the 7-day expiry restarts) and shows it once with a copy button.
 */
export function InviteLinkButton({
  invitationId,
  action,
}: {
  invitationId: number;
  action: (prev: InviteLinkState, formData: FormData) => Promise<InviteLinkState>;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <div className="stack-sm">
      {!state.link && (
        <form action={formAction}>
          <input type="hidden" name="invitationId" value={invitationId} />
          <SubmitButton size="sm" icon="copy" pendingLabel="Creating…">
            New link
          </SubmitButton>
        </form>
      )}
      {state.link && (
        <div className="row-tight" role="status">
          <input className="input mono" readOnly value={state.link} aria-label="Invitation link" style={{ minWidth: 0, maxWidth: 260 }} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={state.link} label="Copy link" />
        </div>
      )}
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}
