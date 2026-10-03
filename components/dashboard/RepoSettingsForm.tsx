"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/Alert";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { INITIAL_SETTINGS_FORM_STATE, type SettingsFormState } from "@/lib/config/settings-form-state";
import { SettingsFields, type SettingsFieldsProps } from "./SettingsFields";

/** The repository review-settings form (R6.14): saves through a server action and shows field errors inline. */
export function RepoSettingsForm({
  repoId,
  editable,
  action,
  ...fields
}: Omit<SettingsFieldsProps, "errors" | "values"> & {
  repoId: number;
  editable: boolean;
  action: (prev: SettingsFormState, formData: FormData) => Promise<SettingsFormState>;
}) {
  const [state, formAction] = useActionState(action, INITIAL_SETTINGS_FORM_STATE);
  return (
    <form action={formAction} className="stack-md" noValidate data-testid="repo-settings-form">
      <input type="hidden" name="repoId" value={repoId} />
      {state.message && (
        <Alert tone={state.status === "saved" ? "success" : "error"} role={state.status === "saved" ? "status" : "alert"}>
          {state.message}
        </Alert>
      )}
      {/* Remount with the submitted values after a failed save, so nothing the user typed is lost. */}
      <fieldset key={state.values ? JSON.stringify(state.values) : "saved"} className="fieldset" disabled={!editable}>
        <SettingsFields {...fields} errors={state.errors} values={state.values} />
      </fieldset>
      {editable && (
        <div className="form-actions">
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save settings
          </SubmitButton>
          <span className="dim">Empty fields inherit the organization default.</span>
        </div>
      )}
    </form>
  );
}
