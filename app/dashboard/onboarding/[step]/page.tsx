import Link from "next/link";
import { redirect } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { backend } from "../../../../src/server";
import { emailOnWeb } from "../../../../src/email";
import { billingConfig, checkoutTrialEnd } from "../../../../src/billing";
import { installHref } from "../../../../src/github-install";
import { providerDisplay, providerShort } from "../../../../src/provider-display";
import { nextStep, resolveStep, type ConfigureStep } from "../../../../src/onboarding-steps";
import { Live } from "../../live";
import { reindex } from "../../actions";
import { WorkspaceInvitations } from "../../invitations";
import { advanceSetup, checkoutFromSetup, continueOnTrial, createSetupWorkspace, finishSetup, inviteFromSetup, saveSetupStep, selectAndIndex } from "../actions";
import { IndexGraph, Stage, TeamArt, TrialArt } from "../art";
import { CommentsStep, SummaryStep, ToolsStep, TriggersStep } from "../configure";
import { loadSetup } from "../setup";
import { ConfigureProgress, Heading, ReadOnlyNote, WizardFrame } from "../wizard";
import { ConnectStep, InviteForm, StepForm } from "../wizard-client";

const ledes: Record<ConfigureStep, string> = {
  summary: "Each review posts one summary comment and edits it in place as the pull request changes. Choose what it includes.",
  comments: "Inline comments are reserved for verified findings. Decide how much reaches the pull request.",
  triggers: "Choose which pull request events start a review. Anyone can still ask with “@openreview review”.",
  tools: "Hand findings to a coding agent and decide what OpenReview may do beyond commenting.",
};

export default async function SetupStep({ params, searchParams }: { params: Promise<{ step: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ step: requested }, query] = await Promise.all([params, searchParams]);
  const { user, organization, status, billing, state } = await loadSetup();
  const step = resolveStep(requested, state);
  if (step !== requested) redirect(`/dashboard/onboarding/${step}`);

  if (step === "workspace" || !organization || !status) return <WizardFrame step="workspace" admin billing={billingConfig().enabled} nextLabel="Create workspace" centered>
    <div className="wizard-panel wizard-card">
      <Heading step="workspace">A workspace holds your repositories, review settings, history and team. You can rename it later.</Heading>
      <StepForm action={createSetupWorkspace} pendingLabel="Creating workspace…">
        <label>Workspace name<input name="name" required maxLength={100} autoFocus placeholder="Acme engineering" /></label>
      </StepForm>
      <WorkspaceInvitations invitations={user.invitations} />
    </div>
  </WizardFrame>;

  const admin = status.admin, organizationId = organization._id, next = nextStep(step, state.billing);
  const frame = { workspace: organization.name, organizationId, admin, completed: state.completed, billing: state.billing, nextHref: next ? `/dashboard/onboarding/${next}` : "/dashboard/analytics" };
  const selected = status.repositories.filter((r) => r.selected);

  if (step === "connect") {
    const accounts = [...status.connections.github.map((g) => ({ label: g.account, kind: "GitHub" })), ...status.connections.providers.map((p) => ({ label: p.name, kind: p.kind }))];
    const repositories = status.repositories.map((r) => ({ _id: r._id, fullName: r.fullName, provider: providerShort(r.provider), detail: providerDisplay(r.provider), selected: r.selected, setupError: r.setupError, status: r.indexStatus }));
    const githubHref = process.env.GITHUB_APP_SLUG && process.env.GITHUB_CLIENT_ID ? installHref(organizationId, "/dashboard/onboarding/connect") : undefined;
    const error = query.error === "github-install" ? `The GitHub App installation didn’t finish: ${query.message ?? "please try again"}.` : undefined;
    return <WizardFrame step="connect" {...frame} nextLabel="Start indexing">
      <ConnectStep action={selectAndIndex} organizationId={organizationId} repositories={repositories} accounts={accounts} githubHref={githubHref} providersHref="/dashboard/settings/providers" admin={admin} error={error}
        heading={<><Heading step="connect">Link the provider that hosts your code, then pick the repositories OpenReview should learn and review.</Heading><ReadOnlyNote admin={admin} /></>} />
    </WizardFrame>;
  }

  if (step === "indexing") {
    const processed = selected.reduce((n, r) => n + (r.job?.processed ?? 0), 0), total = selected.reduce((n, r) => n + (r.job?.total ?? 0), 0), ready = selected.filter((r) => r.ready).length;
    const active = selected.some((r) => ["queued", "indexing"].includes(r.indexStatus) || ["queued", "generating"].includes(r.knowledgeStatus ?? ""));
    return <WizardFrame step="indexing" {...frame} nextLabel="Continue">
      <div className="wizard-panel">
        <Heading step="indexing">OpenReview reads each repository and maps its files, symbols and references, so a review can follow a change into the code it touches. Keep going while this runs.</Heading>
        <ReadOnlyNote admin={admin} />
        {status.onboarding?.reviewsPaused && <p className="setup-note">Automatic reviews are paused until you choose when reviews run, two steps ahead.</p>}
        <div className="table-wrap"><table className="wizard-table"><thead><tr><th>Repository</th><th>Status</th><th>Files</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {selected.map((r) => <tr key={r._id}>
            <td title={providerDisplay(r.provider)}><span className="mono">{r.fullName}</span><br /><span className="muted">{providerShort(r.provider)}</span></td>
            <td><span className={`badge ${r.ready ? "ready" : r.indexStatus}`}>{r.ready ? "ready" : r.indexStatus.replaceAll("_", " ")}</span></td>
            <td className="mono">{r.job ? `${r.job.processed} / ${r.job.total}` : "—"}</td>
            <td>{r.indexStatus === "failed" && !r.nativeIndex && admin && <form action={reindex}><input type="hidden" name="repositoryId" value={r._id} /><button className="small">Retry</button></form>}</td>
          </tr>)}
        </tbody></table></div>
        {selected.some((r) => r.error || r.job?.error) && <p role="alert" className="wizard-error">{selected.map((r) => r.error ?? r.job?.error).filter(Boolean)[0]}</p>}
        <StepForm action={advanceSetup} disabled={!admin}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="step" value="indexing" /></StepForm>
        <Live active={active} />
      </div>
      <Stage caption={`indexed ${processed} / ${total} files · ${ready} of ${selected.length} ${selected.length === 1 ? "repository" : "repositories"} ready`}>
        <IndexGraph samples={status.graph} processed={processed} total={total} complete={selected.length > 0 && ready === selected.length} />
      </Stage>
    </WizardFrame>;
  }

  if (step === "summary" || step === "comments" || step === "triggers" || step === "tools") {
    const props = { action: saveSetupStep, organizationId, defaults: status.defaults, admin, progress: <ConfigureProgress step={step} />, heading: <><Heading step={step}>{ledes[step]}</Heading><ReadOnlyNote admin={admin} /></> };
    return <WizardFrame step={step} {...frame} nextLabel={step === "tools" ? "Save and continue" : "Next"}>
      {step === "summary" ? <SummaryStep {...props} /> : step === "comments" ? <CommentsStep {...props} /> : step === "triggers" ? <TriggersStep {...props} /> : <ToolsStep {...props} agent={organization.defaultAgent} />}
    </WizardFrame>;
  }

  if (step === "team") {
    const pending = admin ? await backend().query(api.users.invitations, { token: user.token, organizationId }) : [];
    return <WizardFrame step="team" {...frame} nextLabel="Continue">
      <div className="wizard-panel">
        <Heading step="team">Invite teammates by GitHub username. They accept from their own dashboard after signing in, and you can change roles later.</Heading>
        <ReadOnlyNote admin={admin} />
        <InviteForm action={inviteFromSetup} organizationId={organizationId} disabled={!admin} />
        {pending.length > 0 && <ul className="wizard-invites">{pending.map((i) => <li key={i._id}><span className="mono">@{i.githubLogin}</span> <span className="badge">{i.role}</span> <span className="muted">expires {new Date(i.expiresAt).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" })}</span></li>)}</ul>}
        {emailOnWeb() && <p className="muted">Email invitations are in Settings → People.</p>}
        <StepForm action={advanceSetup} disabled={!admin}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="step" value="team" /></StepForm>
      </div>
      <Stage caption={`${pending.length} ${pending.length === 1 ? "teammate" : "teammates"} invited`}><TeamArt invited={pending.length} /></Stage>
    </WizardFrame>;
  }

  if (step === "plan" && billing?.enabled) {
    const now = Date.now(), subscribed = billing.plan === "starter", confirming = query.checkout === "success" && !subscribed;
    const trialEnded = billing.trialStarted && billing.trialEndsAt <= now, carries = Boolean(checkoutTrialEnd(billing.trialEndsAt, now));
    const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
    const elapsed = billing.trialStarted ? Math.max(0, Math.min(billing.trialDays, Math.floor((now - billing.trialEndsAt) / 86400000) + billing.trialDays)) : 0;
    const price = process.env.BILLING_SEAT_PRICE_LABEL;
    return <WizardFrame step="plan" {...frame} nextLabel={subscribed || confirming ? "Continue" : carries ? "Add payment method" : "Subscribe"}>
      <div className="wizard-panel">
        <Heading step="plan">{subscribed ? "Your workspace is on the Starter plan. Seats follow your team, so there is nothing else to set up."
          : trialEnded ? "The free trial has ended. Subscribe to the Starter plan to keep reviews running."
          : carries ? `Every workspace starts with ${billing.trialDays} days free. Add a payment method now and nothing is charged until the trial ends, or keep exploring and subscribe later in Settings → Billing.`
          : `Your trial ends ${day(billing.trialEndsAt)}. Subscribing now starts the Starter plan right away, or keep exploring and subscribe later in Settings → Billing.`}</Heading>
        <ReadOnlyNote admin={admin} />
        {confirming && <p role="status" className="setup-note">Payment method saved. Your subscription appears here as soon as Stripe confirms it.</p>}
        {query.checkout === "cancelled" && <p role="status" className="setup-note">Checkout was cancelled; nothing was charged.</p>}
        {query.billing === "error" && <p role="alert" className="wizard-error">Stripe Checkout could not be opened. Try again, or continue on the trial and subscribe later in Settings → Billing.</p>}
        <article className="wizard-plan" aria-labelledby="plan-name">
          <header><h2 id="plan-name">Starter</h2><p className="price">{price ?? "Per seat, billed monthly"}</p></header>
          <ul>
            <li>Unlimited reviews, with a fair-use limit of {billing.reviewsPerSeat} per seat each month</li>
            <li>Review summaries, inline findings and chat on every pull request</li>
            <li>Every connected provider and repository</li>
            <li>Owners, admins and members are seats; viewers are free</li>
          </ul>
          <dl className="facts">
            <dt>Seats</dt><dd>{billing.activeSeats} active</dd>
            <dt>{subscribed ? "Status" : "Trial"}</dt><dd>{subscribed ? <span className={`badge ${billing.status}`}>{billing.status.replaceAll("_", " ")}</span>
              : billing.trialStarted ? `${trialEnded ? "Ended" : "Ends"} ${day(billing.trialEndsAt)} · up to ${billing.trialReviews} reviews a month`
              : `${billing.trialDays} days from your first review · up to ${billing.trialReviews} reviews a month`}</dd>
          </dl>
        </article>
        {admin && (subscribed || confirming
          ? <StepForm action={advanceSetup}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="step" value="plan" /></StepForm>
          : <>
            <form id="wizard-form" action={checkoutFromSetup}><input type="hidden" name="organizationId" value={organizationId} /></form>
            <form action={continueOnTrial}><input type="hidden" name="organizationId" value={organizationId} /><button>{trialEnded ? "Continue without subscribing" : "Continue on the trial"}</button></form>
          </>)}
        <Live active={confirming} />
      </div>
      <Stage caption={subscribed ? `starter plan · ${billing.activeSeats} ${billing.activeSeats === 1 ? "seat" : "seats"}`
        : !billing.trialStarted ? `${billing.trialDays}-day trial · starts with your first review`
        : trialEnded ? "trial ended" : `trial · ${billing.trialDays - elapsed} days left · ${billing.used} of ${billing.trialReviews} reviews used`}>
        <TrialArt days={billing.trialDays} elapsed={elapsed} subscribed={subscribed || confirming} />
      </Stage>
    </WizardFrame>;
  }

  // done
  const d = status.defaults, ready = selected.filter((r) => r.ready).length;
  return <WizardFrame step="done" {...frame} nextLabel="Go to dashboard">
    <div className="wizard-panel">
      <Heading step="done">OpenReview is ready to review. Open a pull request in a selected repository, or ask for a review on an existing one.</Heading>
      <dl className="wizard-recap">
        <div><dt>Repositories</dt><dd>{selected.length} selected · {ready} indexed</dd></div>
        <div><dt>Reviews</dt><dd>{d.automatic ? "Automatic on new pull requests" : "On request or trigger label"}{d.rereview ? ", re-reviewed on new commits" : ""}</dd></div>
        <div><dt>Flagging</dt><dd>{["Custom thresholds", "Quiet", "Balanced", "Thorough"][d.strictness ?? 0]} · up to {d.maxComments} inline comments</dd></div>
        <div><dt>Summary</dt><dd>{(d.summarySections ?? []).filter((s) => s !== "tips").length} sections · {d.commentStyle} comments</dd></div>
        {billing?.enabled && <div><dt>Plan</dt><dd>{billing.plan === "starter" ? "Starter" : `Free trial · ${billing.trialStarted ? `ends ${new Date(billing.trialEndsAt).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" })}` : `${billing.trialDays} days from your first review`}`}</dd></div>}
      </dl>
      <p className="row"><Link href="/dashboard/pulls">Review existing pull requests</Link><Link href="/dashboard/settings/review">Fine-tune per repository</Link></p>
      {admin
        ? <form id="wizard-form" action={finishSetup}><input type="hidden" name="organizationId" value={organizationId} /></form>
        : <ReadOnlyNote admin={admin} />}
    </div>
    <Stage caption="setup complete · reviews follow your settings"><IndexGraph samples={status.graph} processed={1} total={1} complete /></Stage>
  </WizardFrame>;
}
