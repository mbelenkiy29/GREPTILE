import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "../../ui/logo";
import { logout } from "../actions";
import { SignOutForm } from "../../telemetry-identity";
import { finishSetup } from "./actions";
import { ShortcutHint, WizardShortcuts } from "./wizard-client";
import { configureLabels, configureSteps, previousStep, stepsFor, stepTitles, type ConfigureStep, type WizardStep } from "../../../src/onboarding-steps";

/** Full-screen setup frame: identity row, the step body, and a persistent bar with Back / Next. */
export function WizardFrame({ step, workspace, organizationId, admin, completed, billing = false, nextLabel, nextHref, centered, children }: {
  step: WizardStep; workspace?: string; organizationId?: string; admin: boolean; completed?: boolean; billing?: boolean;
  nextLabel: string; nextHref?: string; centered?: boolean; children: ReactNode;
}) {
  const steps = stepsFor(billing), back = previousStep(step, billing), position = steps.indexOf(step) + 1;
  return <main className="wizard" data-step={step}>
    <header className="wizard-top">
      <span className="brand"><Mark /> OpenReview</span>
      {workspace && <span className="muted wizard-workspace">{workspace} · setup</span>}
      <span className="wizard-position">Step {position} of {steps.length}</span>
    </header>
    <div className={`wizard-body${centered ? " centered" : ""}`}>{children}</div>
    <footer className="wizard-bar">
      <div className="wizard-exit">
        <SignOutForm action={logout} label="Log out" />
        {organizationId && step !== "done" && (admin && !completed
          ? <form action={finishSetup}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="skipped" value="true" /><button className="small">Exit setup</button></form>
          : <Link className="button small" href="/dashboard/analytics">Back to dashboard</Link>)}
      </div>
      <p className="wizard-step-label">{stepTitles[step]}</p>
      <nav className="wizard-nav" aria-label="Setup steps">
        {back && <Link className="button" href={`/dashboard/onboarding/${back}`}>Back</Link>}
        {admin || step === "workspace"
          ? <button className="primary" type="submit" form="wizard-form" aria-keyshortcuts="Meta+Enter Control+Enter">{nextLabel} <ShortcutHint /></button>
          : nextHref && <Link className="button primary" href={nextHref}>Next</Link>}
      </nav>
    </footer>
    <WizardShortcuts nextHref={admin ? undefined : nextHref} />
  </main>;
}

export function Heading({ step, children }: { step: WizardStep; children: ReactNode }) {
  return <div className="wizard-heading"><h1 tabIndex={-1} data-wizard-heading>{stepTitles[step]}</h1><p className="wizard-lede">{children}</p></div>;
}
export function ConfigureProgress({ step }: { step: ConfigureStep }) {
  const at = configureSteps.indexOf(step);
  return <ol className="wizard-progress" aria-label="Review configuration">
    {configureSteps.map((s, i) => <li key={s} aria-current={i === at ? "step" : undefined} data-done={i < at || undefined}>{configureLabels[s]}</li>)}
  </ol>;
}
export function ReadOnlyNote({ admin }: { admin: boolean }) {
  return admin ? null : <p className="muted" role="note">A workspace admin manages setup. You can look through each step.</p>;
}
