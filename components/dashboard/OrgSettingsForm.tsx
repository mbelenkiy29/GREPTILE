"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/Alert";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { INITIAL_SETTINGS_FORM_STATE, type SettingsFormState } from "@/lib/config/settings-form-state";
import { SettingsFields, type SettingsFieldsProps } from "./SettingsFields";

/** The organization's review defaults (R6.14): every setting, saved through a server action with inline errors. */
export function OrgSettingsForm({
  editable,
  action,
  ...fields
}: Omit<SettingsFieldsProps, "errors" | "values" | "scope"> & {
  editable: boolean;
  action: (prev: SettingsFormState, formData: FormData) => Promise<SettingsFormState>;
}) {
  const [state, formAction] = useActionState(action, INITIAL_SETTINGS_FORM_STATE);
  return (
    <form action={formAction} className="stack-md" noValidate data-testid="org-settings-form">
      {state.message && (
        <Alert tone={state.status === "saved" ? "success" : "error"} role={state.status === "saved" ? "status" : "alert"}>
          {state.message}
        </Alert>
      )}
      <fieldset key={state.values ? JSON.stringify(state.values) : "saved"} className="fieldset" disabled={!editable}>
        <SettingsFields {...fields} scope="org" errors={state.errors} values={state.values} />
      </fieldset>
      {editable && (
        <div className="form-actions">
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save defaults
          </SubmitButton>
          <span className="dim">Empty fields use the built-in default.</span>
        </div>
      )}
    </form>
  );
}
