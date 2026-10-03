"use client";

import { useActionState } from "react";

export interface UsageFormState {
  error?: string;
  saved?: boolean;
}

/** Caps and alert settings (R4.3): credit cap, model cost cap, alert thresholds, and the alert webhook URL. */
export function UsageLimitsForm({
  action,
  values,
}: {
  action: (prev: UsageFormState, formData: FormData) => Promise<UsageFormState>;
  values: { monthlyCreditCap: number | null; monthlyCostCapUsd: number | null; alertThresholds: number[]; alertWebhookUrl: string | null };
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="stack-md" data-testid="usage-limits-form">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field" style={{ flex: "1 1 200px" }}>
          <label className="field-label" htmlFor="ul-credits">
            Credit cap per period
          </label>
          <input id="ul-credits" className="input" name="monthlyCreditCap" type="number" min={0} step={1} defaultValue={values.monthlyCreditCap ?? ""} placeholder="No cap" aria-describedby="ul-credits-help" />
          <p className="field-help" id="ul-credits-help">
            Hard cap: no new reviews, answers, or knowledge refreshes once reached. Empty for none.
          </p>
        </div>
        <div className="field" style={{ flex: "1 1 200px" }}>
          <label className="field-label" htmlFor="ul-cost">
            Model cost cap per period (USD)
          </label>
          <input id="ul-cost" className="input" name="monthlyCostCapUsd" type="number" min={0} step="0.01" defaultValue={values.monthlyCostCapUsd ?? ""} placeholder="No cap" aria-describedby="ul-cost-help" />
          <p className="field-help" id="ul-cost-help">
            Hard cap on estimated model spend. Empty for none.
          </p>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ul-thresholds">
          Alert thresholds (% of each limit)
        </label>
        <input id="ul-thresholds" className="input" name="alertThresholds" defaultValue={values.alertThresholds.join(", ")} placeholder="50, 80, 100" aria-describedby="ul-thresholds-help" />
        <p className="field-help" id="ul-thresholds-help">
          Crossing one shows a banner across the dashboard and sends the alert webhook once per period. Empty turns alerts off.
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ul-webhook">
          Alert webhook URL (optional)
        </label>
        <input id="ul-webhook" className="input" name="alertWebhookUrl" type="url" defaultValue={values.alertWebhookUrl ?? ""} placeholder="https://hooks.example.com/openreview" aria-describedby="ul-webhook-help" autoComplete="off" />
        <p className="field-help" id="ul-webhook-help">
          Receives a signed JSON POST per crossed threshold. Must be a public https URL.
        </p>
      </div>
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      {state.saved && !state.error && (
        <p className="dim" role="status">
          Saved.
        </p>
      )}
      <div>
        <button className="button button-primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save caps and alerts"}
        </button>
      </div>
    </form>
  );
}
