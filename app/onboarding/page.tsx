import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { UserMenu } from "@/components/auth/UserMenu";
import {
  ConfigureStep,
  IndexingStep,
  InstallStep,
  OnboardingStepper,
  ReadyStep,
  RepoSelectStep,
  WorkspaceStep,
  type InstallationSummary,
  type RepoGroup,
} from "@/components/onboarding/Steps";
import { Brand } from "@/components/shell/Brand";
import { PageHeader } from "@/components/ui/PageHeader";
import { Toaster } from "@/components/ui/Toast";
import { requireUserOrg } from "@/lib/auth";
import { authConfig } from "@/lib/auth/config";
import { installMessage } from "@/lib/auth/messages";
import { can } from "@/lib/auth/permissions";
import { resolveEffectiveSettings } from "@/lib/config/settings";
import { db } from "@/lib/db";
import { getInstallationHealth, listRepos } from "@/lib/data/installations";
import { listInvitationsForUser } from "@/lib/data/members";
import {
  canViewStep,
  getOnboardingState,
  indexProgressForOrg,
  listClaimableInstallations,
  ONBOARDING_STEP_LABEL,
  ONBOARDING_STEPS,
  reviewableRepos,
  type OnboardingStep,
} from "@/lib/data/onboarding";
import { listUserOrgs, ORG_ERROR_MESSAGES, orgErrorCode } from "@/lib/data/orgs";
import { getOrgSettings } from "@/lib/data/settings";
import { siteEnv } from "@/lib/env";
import { githubInstallationSettingsUrl } from "@/lib/ui/format";
import { enumParam, param, type SearchParams } from "@/lib/ui/url";
import {
  acceptWorkspaceInvitation,
  chooseWorkspace,
  connectInstallation,
  createWorkspace,
  finishOnboarding,
  retryIndexing,
  reviewExistingPullRequest,
  saveOnboardingDefaults,
  saveRepoSelection,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Get started" };

const REVIEW_ERRORS: Record<string, string> = {
  invalid: "Pick a repository and enter a pull request number.",
  not_found: "That repository isn't connected to this workspace.",
  disabled: "Reviews are turned off for that repository. Turn them on in the repository selection step.",
  forbidden: "You can't request reviews in this workspace.",
  limited: "This workspace reached a usage cap or plan limit, so the review wasn't queued. See Settings → Usage & billing.",
};

/** The onboarding wizard (R6.2). It resumes at the first unfinished step; `?step=` revisits an earlier one. */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, ctx } = await requireUserOrg();
  const sp = await searchParams;
  const state = await getOnboardingState(db(), ctx?.orgId ?? null);
  const asked = enumParam(sp, "step", ONBOARDING_STEPS);
  // Without a workspace only step 1 makes sense; otherwise any step up to the first unfinished one can be viewed.
  const step: OnboardingStep = !ctx ? "workspace" : asked && canViewStep(state, asked) ? asked : state.current;
  const web = siteEnv().GITHUB_WEB_URL;

  let panel: ReactNode;
  if (step === "workspace" || !ctx) {
    const [orgs, invitations] = await Promise.all([
      listUserOrgs(db(), session.userId),
      listInvitationsForUser(db(), { id: session.userId, email: session.user.email, githubLogin: session.user.githubLogin }, new Date()),
    ]);
    const code = orgErrorCode(param(sp, "error"));
    panel = (
      <WorkspaceStep
        current={ctx ? { id: ctx.orgId, name: ctx.orgName, role: ctx.role } : null}
        orgs={orgs}
        invitations={invitations}
        error={code ? ORG_ERROR_MESSAGES[code] : null}
        actions={{ create: createWorkspace, choose: chooseWorkspace, accept: acceptWorkspaceInvitation }}
      />
    );
  } else if (step === "install") {
    const canManage = can(ctx.role, "repos.manage");
    const config = authConfig();
    const [health, claimable] = await Promise.all([
      getInstallationHealth(db(), ctx.orgId),
      canManage ? listClaimableInstallations({ db: db(), apiUrl: config.githubApiUrl }, ctx.userId) : Promise.resolve(null),
    ]);
    const installations: InstallationSummary[] = health.map((h) => ({
      id: h.id,
      provider: h.provider,
      externalId: h.externalId,
      accountLogin: h.accountLogin,
      status: h.status,
      missingPermissions: h.missingPermissions,
      missingRecommended: h.missingRecommended,
      manageUrl: h.provider === "github" ? githubInstallationSettingsUrl(h, web) : `/dashboard/settings/git-providers/${h.scmCredentialId ?? ""}`,
    }));
    panel = (
      <InstallStep
        canManage={canManage}
        role={ctx.role}
        installations={installations}
        claimable={claimable}
        message={installMessage(param(sp, "install")) ?? null}
        connectAction={connectInstallation}
      />
    );
  } else if (step === "repos") {
    const [health, repos] = await Promise.all([getInstallationHealth(db(), ctx.orgId), listRepos(db(), ctx.orgId)]);
    // GitLab / Bitbucket repositories are chosen (and their webhooks created) on Settings → Git providers.
    const groups: RepoGroup[] = health.filter((h) => h.provider === "github").map((h) => ({
      installation: { id: h.id, accountLogin: h.accountLogin, repositorySelection: h.repositorySelection, manageUrl: githubInstallationSettingsUrl(h, web) },
      repos: repos
        .filter((r) => r.installationId === h.id)
        .map((r) => ({ id: r.id, fullName: r.fullName, enabled: r.enabled, archived: r.archived, private: r.private })),
    }));
    const otherHosts = health.filter((h) => h.provider !== "github").length;
    panel = <RepoSelectStep canManage={can(ctx.role, "repos.manage")} role={ctx.role} groups={groups} action={saveRepoSelection} otherHosts={otherHosts} />;
  } else if (step === "configure") {
    const org = await getOrgSettings(db(), ctx.orgId);
    const { settings } = resolveEffectiveSettings(org, undefined, undefined);
    panel = <ConfigureStep canManage={can(ctx.role, "settings.manage")} role={ctx.role} defaults={settings} action={saveOnboardingDefaults} />;
  } else if (step === "indexing") {
    const repos = await indexProgressForOrg(db(), ctx.orgId);
    panel = <IndexingStep repos={repos} retryAction={can(ctx.role, "repos.manage") ? retryIndexing : undefined} />;
  } else {
    const repos = await reviewableRepos(db(), ctx.orgId);
    const reviewError = param(sp, "review");
    panel = (
      <ReadyStep
        repos={repos}
        canTrigger={can(ctx.role, "reviews.trigger")}
        canFinish={can(ctx.role, "settings.manage")}
        reviewError={reviewError && Object.hasOwn(REVIEW_ERRORS, reviewError) ? REVIEW_ERRORS[reviewError]! : null}
        docsUrl={`${siteEnv().SOURCE_CODE_URL}/blob/main/docs/OPENREVIEW_SPEC.md`}
        actions={{ review: reviewExistingPullRequest, finish: finishOnboarding }}
      />
    );
  }

  const index = ONBOARDING_STEPS.indexOf(step);
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <div style={{ minWidth: 0, maxWidth: 260 }}>
          <UserMenu user={session.user} align="end" />
        </div>
      </header>
      <main id="main" className="stack">
        <PageHeader
          title="Get started with OpenReview"
          description={ctx ? `Setting up ${ctx.orgName}. Your progress is saved as you go.` : "Set up AI code review for your team in a few steps."}
        />
        <OnboardingStepper state={state} viewing={step} />
        <section className="card card-body stack" aria-labelledby="ob-step-title">
          <div className="stack-sm">
            <span className="eyebrow">
              Step {index + 1} of {ONBOARDING_STEPS.length}
            </span>
            <h2 id="ob-step-title">{ONBOARDING_STEP_LABEL[step]}</h2>
          </div>
          {panel}
        </section>
      </main>
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
    </div>
  );
}
