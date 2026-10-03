/** Result shape of the rule form action (R6.11); free of server imports so the client form can use it. */

export type RuleFormField = "title" | "text" | "category" | "severity" | "enabled" | "instructions" | "paths" | "scope" | "repoId" | "form";
export type RuleFormErrors = Partial<Record<RuleFormField, string>>;

export interface RuleFormState {
  status: "idle" | "saved" | "invalid" | "forbidden" | "not_found";
  errors: RuleFormErrors;
  message: string | null;
  /** The saved rule. */
  ruleId?: number;
  /** What was submitted, so an invalid form is shown again as the user left it. */
  values?: Record<string, string>;
}

export const INITIAL_RULE_FORM_STATE: RuleFormState = { status: "idle", errors: {}, message: null };
