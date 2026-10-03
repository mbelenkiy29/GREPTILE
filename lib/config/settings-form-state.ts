/** Result shape of the repository settings form action (R6.14); free of server imports so the client form can use it. */
import type { SettingKey } from "./settings";

export type SettingsFormErrors = Partial<Record<SettingKey | "form", string>>;

export interface SettingsFormState {
  status: "idle" | "saved" | "invalid" | "forbidden" | "not_found";
  errors: SettingsFormErrors;
  message: string | null;
  /** What was submitted, so an invalid form is shown again as the user left it. */
  values?: Record<string, string | string[]>;
}

export const INITIAL_SETTINGS_FORM_STATE: SettingsFormState = { status: "idle", errors: {}, message: null };
