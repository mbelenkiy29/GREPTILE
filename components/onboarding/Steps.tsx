import Link from "next/link";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ROLE_LABEL, type Role } from "@/lib/auth/permissions";
import { COMMENT_STYLES, type EffectiveSettings } from "@/lib/config/settings";
import { REVIEW_MODE_HINTS } from "@/lib/config/mode-hints";
import type { InvitationView } from "@/lib/data/members";
import { canViewStep, ONBOARDING_STEP_LABEL, type ClaimableResult, type OnboardingState, type OnboardingStep, type RepoIndexProgress } from "@/lib/data/onboarding";
import type { UserOrg } from "@/lib/data/orgs";
import { SEVERITIES } from "@/lib/engine/types";
import { providerIcon } from "@/lib/git/web-url";
import { IndexProgressList } from "./IndexProgressList";

type Action = (formData: FormData) => Promise<void>;

/** The wizard's progress: every step with its state; done and current steps link to themselves. */
export function OnboardingStepper({ state, viewing }: { state: OnboardingState; viewing: OnboardingStep }) {
  return (
    <nav aria-label="Onboarding progress">
      <ol className="stepper" data-testid="onboarding-stepper">
        {state.steps.map((s, i) => {
          const status = s.done ? "done" : s.id === state.current ? "current" : "todo";
          const label = (
            <>
              <span className="stepper-dot" aria-hidden="true">
                {s.done ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <span className="stepper-label">{s.label}</span>
              <span className="sr-only">{s.done ? " (done)" : s.id === state.current ? " (next)" : ""}</span>
            </>
          );
          return (
            <li key={s.id} className="stepper-step" data-state={status} data-step={s.id}>
              {canViewStep(state, s.id) ? (
                <Link href={`/onboarding?step=${s.id}`} aria-current={s.id === viewing ? "step" : undefined}>
                  {label}
                </Link>
              ) : (
                <span aria-current={s.id === viewing ? "step" : undefined}>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Next/back links under a step. */
export function StepNav({ back, next, nextLabel = "Continue" }: { back?: OnboardingStep; next?: OnboardingStep; nextLabel?: string }) {
  return (
    <div className="form-actions">
      {back && (
        <ButtonLink href={`/onboarding?step=${back}`} variant="ghost">
          Back
        </ButtonLink>
      )}
      {next && (
        <ButtonLink href={`/onboarding?step=${next}`} variant="primary">
          {nextLabel}
        </ButtonLink>
      )}
    </div>
  );
}

/** Shown to members on steps only owners and admins can complete. */
export function AdminOnly({ step, role, children }: { step: OnboardingStep; role: Role; children?: ReactNode }) {
  return (
    <Alert tone="info" title={`${ONBOARDING_STEP_LABEL[step]} is set up by an owner or admin`}>
      <p>
        You&apos;re a {ROLE_LABEL[role].toLowerCase()} in this workspace, so this step is read-only for you. Ask an owner or admin to finish it;
        you&apos;ll see the result here.
      </p>
      {children}
    </Alert>
  );
}

// ---- 1. workspace -------------------------------------------------------------------------------------------------

export function WorkspaceStep({
  current,
  orgs,
  invitations,
  error,
  actions,
}: {
  current: { id: string; name: string; role: Role } | null;
  orgs: UserOrg[];
  invitations: InvitationView[];
  error: string | null;
  actions: { create: Action; choose: Action; accept: Action };
}) {
  return (
    <div className="stack" data-step-panel="workspace">
      <p className="dim">A workspace holds your repositories, rules, and team. Create one for your team, continue in one you belong to, or accept an invitation.</p>
      {error && <Alert tone="error">{error}</Alert>}
      {current && (
        <Alert tone="success" title={`You're working in ${current.name}`}>
          <p>As {ROLE_LABEL[current.role].toLowerCase()}. Continue, or pick a different workspace below.</p>
          <StepNav next="install" />
        </Alert>
      )}
      {invitations.length > 0 && (
        <section className="stack-sm" aria-labelledby="ob-invites">
          <h3 id="ob-invites">Invitations for you</h3>
          <ul className="comments">
            {invitations.map((inv) => (
              <li key={inv.id} className="comment row" data-invitation={inv.id}>
                <span>
                  <span className="strong">{inv.orgName}</span>{" "}
                  <span className="dim">
                    as {ROLE_LABEL[inv.role]}
                    {inv.invitedByName ? ` · invited by ${inv.invitedByName}` : ""}
                  </span>
                </span>
                <span className="spacer" />
                <form action={actions.accept}>
                  <input type="hidden" name="invitationId" value={inv.id} />
                  <SubmitButton size="sm" variant="primary">
                    Accept and continue
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
      {orgs.length > 0 && (
        <section className="stack-sm" aria-labelledby="ob-orgs">
          <h3 id="ob-orgs">Your workspaces</h3>
          <ul className="comments">
            {orgs.map((o) => (
              <li key={o.id} className="comment row" data-org={o.slug}>
                <span className="break">
                  <span className="strong">{o.name}</span> {o.personal && <Badge>Personal</Badge>} <span className="dim">· {ROLE_LABEL[o.role]}</span>
                </span>
                <span className="spacer" />
                {o.id === current?.id ? (
                  <Badge tone="accent">Current</Badge>
                ) : (
                  <form action={actions.choose}>
                    <input type="hidden" name="orgId" value={o.id} />
                    <SubmitButton size="sm">Use this workspace</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Card title="Create a workspace" titleId="ob-create" description="You become its owner and can invite teammates later.">
        <form action={actions.create} className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "1 1 220px" }}>
            <label className="field-label" htmlFor="ob-org-name">
              Workspace name
            </label>
            <input id="ob-org-name" className="input" name="name" required minLength={1} maxLength={80} placeholder="Acme Engineering" autoComplete="organization" />
          </div>
          <SubmitButton variant="primary" icon="plus" pendingLabel="Creating…">
            Create workspace
          </SubmitButton>
        </form>
      </Card>
    </div>
  );
}

// ---- 2. install ---------------------------------------------------------------------------------------------------

export interface InstallationSummary {
  id: number;
  /** `github`, `gitlab`, or `bitbucket` (R3.6). */
  provider?: string;
  externalId: number;
  accountLogin: string;
  status: "ok" | "missing_permissions" | "suspended";
  missingPermissions: string[];
  missingRecommended: string[];
  manageUrl: string;
}

export function InstallStep({
  canManage,
  role,
  installations,
  claimable,
  message,
  connectAction,
}: {
  canManage: boolean;
  role: Role;
  installations: InstallationSummary[];
  claimable: ClaimableResult | null;
  message: string | null;
  connectAction: Action;
}) {
  const connected = installations.length > 0;
  return (
    <div className="stack" data-step-panel="install">
      <p className="dim">
        OpenReview reads code and posts reviews on your git host: install the GitHub App on a GitHub account or organization, or connect
        GitLab or Bitbucket Cloud with an access token.
      </p>
      {message && <Alert tone="info">{message}</Alert>}
      {!canManage && <AdminOnly step="install" role={role} />}
      {connected && (
        <section className="stack-sm" aria-labelledby="ob-installed">
          <h3 id="ob-installed">Connected installations</h3>
          <ul className="comments">
            {installations.map((i) => (
              <li key={i.id} className="comment" data-installation={i.externalId} data-status={i.status}>
                <div className="row">
                  <Icon name={providerIcon(i.provider)} size={16} />
                  <span className="strong">{i.accountLogin}</span>
                  <span className="spacer" />
                  <Badge tone={i.status === "ok" ? "ok" : i.status === "suspended" ? "bad" : "warn"}>
                    {i.status === "ok" ? "Healthy" : i.status === "suspended" ? "Suspended" : "Missing permissions"}
                  </Badge>
                </div>
                {i.missingPermissions.length > 0 && (
                  <p className="error-text">
                    Missing required permissions: <span className="mono">{i.missingPermissions.join(", ")}</span>. Accept the updated permissions on
                    GitHub.
                  </p>
                )}
                {i.missingRecommended.length > 0 && (
                  <p className="dim">
                    Recommended: <span className="mono">{i.missingRecommended.join(", ")}</span> (CI status as review context).
                  </p>
                )}
                {i.status === "suspended" && <p className="error-text">This installation is suspended on GitHub, so nothing is reviewed until it&apos;s unsuspended.</p>}
                {(i.provider ?? "github") === "github" ? (
                  <a href={i.manageUrl} target="_blank" rel="noreferrer">
                    Manage on GitHub <Icon name="external" size={12} />
                  </a>
                ) : (
                  <Link href={i.manageUrl}>Choose repositories</Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {canManage && (
        <div className="row">
          <ButtonLink href="/api/github/install?from=onboarding" variant={connected ? "default" : "primary"} icon="github">
            {connected ? "Install on another account" : "Install the GitHub App"}
          </ButtonLink>
          <ButtonLink href="/dashboard/settings/git-providers" icon="gitlab">
            Connect GitLab
          </ButtonLink>
          <ButtonLink href="/dashboard/settings/git-providers" icon="bitbucket">
            Connect Bitbucket
          </ButtonLink>
        </div>
      )}
      {canManage && claimable && <ClaimableInstallations claimable={claimable} connectAction={connectAction} />}
      <StepNav back="workspace" next={connected ? "repos" : undefined} />
    </div>
  );
}

function ClaimableInstallations({ claimable, connectAction }: { claimable: ClaimableResult; connectAction: Action }) {
  if (claimable.status === "reauthorize") {
    return (
      <p className="dim">
        Already installed the app on GitHub?{" "}
        <a href={`/api/auth/github?next=${encodeURIComponent("/onboarding?step=install")}`}>Sign in with GitHub again</a> so we can find installations
        you can access.
      </p>
    );
  }
  if (claimable.status === "github_unavailable") {
    return <p className="dim">We couldn&apos;t reach GitHub to look for existing installations. Reload to try again.</p>;
  }
  if (!claimable.installations.length) return null;
  return (
    <section className="stack-sm" aria-labelledby="ob-claim">
      <h3 id="ob-claim">Connect an existing installation</h3>
      <p className="dim">These installations of the app aren&apos;t connected to any workspace yet, and your GitHub account can access them.</p>
      <ul className="comments">
        {claimable.installations.map((p) => (
          <li key={p.externalId} className="comment row" data-pending={p.externalId}>
            <span className="break">
              <span className="strong">{p.accountLogin}</span>{" "}
              <span className="dim">
                · {p.accountType === "Organization" ? "organization" : "user"} · installed by @{p.senderLogin}
                {p.repositorySelection === "all" ? " · all repositories" : p.repositorySelection === "selected" ? " · selected repositories" : ""}
              </span>
            </span>
            <span className="spacer" />
            <form action={connectAction}>
              <input type="hidden" name="installationId" value={p.externalId} />
              <SubmitButton size="sm" variant="primary" pendingLabel="Connecting…">
                Connect existing installation
              </SubmitButton>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- 3. repositories ----------------------------------------------------------------------------------------------

export interface RepoGroup {
  installation: { id: number; accountLogin: string; repositorySelection: string | null; manageUrl: string };
  repos: { id: number; fullName: string; enabled: boolean; archived: boolean; private: boolean }[];
}

export function RepoSelectStep({
  canManage,
  role,
  groups,
  action,
  otherHosts = 0,
}: {
  canManage: boolean;
  role: Role;
  groups: RepoGroup[];
  action: Action;
  /** Connected GitLab / Bitbucket hosts, whose repositories are chosen on Settings → Git providers. */
  otherHosts?: number;
}) {
  const total = groups.reduce((n, g) => n + g.repos.length, 0);
  return (
    <div className="stack" data-step-panel="repos">
      <p className="dim">Choose the repositories OpenReview reviews. You can change this any time on the Repositories page.</p>
      {!canManage && <AdminOnly step="repos" role={role} />}
      <Alert tone="neutral" title="Repository access is managed on GitHub">
        <p>
          Only repositories the GitHub App can access appear here. To add more, change the installation&apos;s repository access on GitHub; they show
          up here within a minute.
        </p>
      </Alert>
      {otherHosts > 0 && (
        <p className="dim">
          GitLab and Bitbucket repositories are enabled on <Link href="/dashboard/settings/git-providers">Settings → Git providers</Link>, which also
          creates their webhooks.
        </p>
      )}
      {total === 0 ? (
        <EmptyState icon="repo" title="No repositories yet" headingLevel={3} actions={<StepNav back="install" />}>
          <p>The installation doesn&apos;t include any repositories. Add some on GitHub, then reload this page.</p>
        </EmptyState>
      ) : (
        <form action={action} className="stack" data-testid="repo-selection">
          {groups.map((g) => (
            <fieldset key={g.installation.id} className="fieldset stack-sm" disabled={!canManage}>
              <legend className="strong">
                {g.installation.accountLogin}{" "}
                <span className="dim">
                  · {g.repos.length} repositor{g.repos.length === 1 ? "y" : "ies"}
                  {g.installation.repositorySelection === "all" ? " (all repositories)" : ""}
                </span>
              </legend>
              <div className="checks checks-stack">
                {g.repos.map((r) => (
                  <label key={r.id} className="check" data-repo={r.fullName}>
                    <input type="checkbox" name="repoId" value={r.id} defaultChecked={r.enabled && !r.archived} disabled={r.archived} />
                    <span className="break">
                      {r.fullName}
                      {r.private ? <span className="dim"> · private</span> : null}
                      {r.archived ? <span className="dim"> · archived on GitHub (read-only)</span> : null}
                    </span>
                  </label>
                ))}
              </div>
              <a href={g.installation.manageUrl} target="_blank" rel="noreferrer">
                Add or remove repositories on GitHub <Icon name="external" size={12} />
              </a>
            </fieldset>
          ))}
          <div className="form-actions">
            <ButtonLink href="/onboarding?step=install" variant="ghost">
              Back
            </ButtonLink>
            {canManage ? (
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Save and continue
              </SubmitButton>
            ) : (
              <ButtonLink href="/onboarding?step=configure" variant="primary">
                Continue
              </ButtonLink>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

// ---- 4. review behavior -------------------------------------------------------------------------------------------

export function ConfigureStep({ canManage, role, defaults, action }: { canManage: boolean; role: Role; defaults: EffectiveSettings; action: Action }) {
  return (
    <form action={action} className="stack" data-step-panel="configure" data-testid="onboarding-defaults">
      <p className="dim">
        Organization-wide defaults. Every repository inherits them unless it sets its own on its Settings tab or in an <code>openreview.json</code>.
      </p>
      {!canManage && <AdminOnly step="configure" role={role} />}
      <fieldset className="fieldset stack" disabled={!canManage}>
        <fieldset className="fieldset">
          <legend className="field-label">Review mode</legend>
          <div className="choice-grid">
            {(Object.keys(REVIEW_MODE_HINTS) as (keyof typeof REVIEW_MODE_HINTS)[]).map((m) => (
              <label key={m} className="choice" data-mode={m}>
                <input type="radio" name="mode" value={m} defaultChecked={defaults.mode === m} />
                <span className="choice-body">
                  <span className="strong">{REVIEW_MODE_HINTS[m].label}</span>
                  <span className="badge badge-muted">{REVIEW_MODE_HINTS[m].cost}</span>
                  <span className="dim">{REVIEW_MODE_HINTS[m].detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-row">
          <label className="check">
            <input type="checkbox" name="autoReview" value="true" defaultChecked={defaults.autoReview} />
            <input type="hidden" name="autoReview" value="false" />
            <span>Review pull requests automatically when they&apos;re opened</span>
          </label>
          <label className="check">
            <input type="checkbox" name="reviewDrafts" value="true" defaultChecked={defaults.reviewDrafts} />
            <input type="hidden" name="reviewDrafts" value="false" />
            <span>Also review draft pull requests</span>
          </label>
        </div>
        <div className="form-row">
          <div className="field">
            <label className="field-label" htmlFor="ob-min-severity">
              Minimum severity
            </label>
            <select id="ob-min-severity" name="minSeverity" className="select" defaultValue={defaults.minSeverity} aria-describedby="ob-min-severity-help">
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <p className="field-help" id="ob-min-severity-help">
              Findings below this aren&apos;t posted.
            </p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ob-max-comments">
              Max comments per review
            </label>
            <input
              id="ob-max-comments"
              name="maxComments"
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              defaultValue={defaults.maxComments}
              aria-describedby="ob-max-comments-help"
            />
            <p className="field-help" id="ob-max-comments-help">
              0 to 100. The most important findings are posted first.
            </p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ob-comment-style">
              Comment style
            </label>
            <select id="ob-comment-style" name="commentStyle" className="select" defaultValue={defaults.commentStyle}>
              {COMMENT_STYLES.map((s) => (
                <option key={s} value={s}>
                  {s === "concise" ? "Concise" : "Detailed"}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>
      <div className="form-actions">
        <ButtonLink href="/onboarding?step=repos" variant="ghost">
          Back
        </ButtonLink>
        {canManage ? (
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save and continue
          </SubmitButton>
        ) : (
          <ButtonLink href="/onboarding?step=indexing" variant="primary">
            Continue
          </ButtonLink>
        )}
      </div>
    </form>
  );
}

// ---- 5. indexing --------------------------------------------------------------------------------------------------

export function IndexingStep({ repos, retryAction }: { repos: RepoIndexProgress[]; retryAction?: Action }) {
  return (
    <div className="stack" data-step-panel="indexing">
      <p className="dim">
        OpenReview indexes each repository&apos;s files, symbols, and dependencies so reviews see the whole codebase, not just the diff. Large repositories
        take a few minutes; you can continue while it runs.
      </p>
      <IndexProgressList initial={repos} retryAction={retryAction} />
      <StepNav back="configure" next="ready" />
    </div>
  );
}

// ---- 6. ready -----------------------------------------------------------------------------------------------------

export function ReadyStep({
  repos,
  canTrigger,
  canFinish,
  reviewError,
  docsUrl,
  actions,
}: {
  repos: { id: number; fullName: string }[];
  canTrigger: boolean;
  canFinish: boolean;
  reviewError: string | null;
  docsUrl: string;
  actions: { review: Action; finish: Action };
}) {
  return (
    <div className="stack" data-step-panel="ready">
      <Alert tone="success" title="You're ready">
        <p>Open a pull request in an enabled repository — OpenReview reviews it automatically and comments on the lines that need attention.</p>
      </Alert>
      {canTrigger && repos.length > 0 && (
        <Card title="Review an existing pull request" titleId="ob-review" description="Queue a review of a pull request that's already open.">
          <form action={actions.review} className="row" style={{ alignItems: "flex-end" }} data-testid="review-existing">
            <div className="field" style={{ flex: "1 1 220px" }}>
              <label className="field-label" htmlFor="ob-review-repo">
                Repository
              </label>
              <select id="ob-review-repo" name="repoId" className="select" required>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: "0 1 140px" }}>
              <label className="field-label" htmlFor="ob-review-pr">
                PR number
              </label>
              <input id="ob-review-pr" name="prNumber" className="input" type="number" inputMode="numeric" min={1} required placeholder="42" />
            </div>
            <SubmitButton variant="primary" icon="play" pendingLabel="Queuing…">
              Review it
            </SubmitButton>
          </form>
          {reviewError && (
            <p className="field-error" role="alert">
              {reviewError}
            </p>
          )}
        </Card>
      )}
      <div className="row">
        <ButtonLink href="/dashboard/rules" icon="rules">
          Write team rules
        </ButtonLink>
        <ButtonLink href={docsUrl} external variant="ghost">
          Read the docs
        </ButtonLink>
        <span className="spacer" />
        {canFinish ? (
          <form action={actions.finish}>
            <SubmitButton variant="primary">Go to the dashboard</SubmitButton>
          </form>
        ) : (
          <ButtonLink href="/dashboard" variant="primary">
            Go to the dashboard
          </ButtonLink>
        )}
      </div>
    </div>
  );
}
