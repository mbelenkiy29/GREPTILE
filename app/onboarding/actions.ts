"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg, requireUser } from "@/lib/auth";
import { authConfig } from "@/lib/auth/config";
import { setActiveOrg } from "@/lib/auth/sessions";
import { saveOrgSettingsForm } from "@/lib/config/settings-form";
import { db } from "@/lib/db";
import { acceptInvitationById } from "@/lib/data/members";
import { completeOnboarding, connectPendingInstallation, requestManualReview, setEnabledRepos, type OnboardingStep } from "@/lib/data/onboarding";
import { createOrg, OrgError } from "@/lib/data/orgs";
import { webhookGitHost } from "@/lib/git/host";
import { queueManualIndex } from "@/lib/indexer/jobs";
import { enqueueIndexForNewRepos } from "@/lib/jobs/enqueue";
import { bullQueue } from "@/lib/jobs/queue";
import { errorMessage, log } from "@/lib/log";
import { withToast, type ToastCode } from "@/lib/ui/toast";

/*
 * Onboarding wizard actions (R6.2). Each one checks the session (and the permission its step needs) itself; the org
 * always comes from the session, never from the form.
 */

function stepPath(step: OnboardingStep, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ step, ...extra });
  return `/onboarding?${q.toString()}`;
}

function go(step: OnboardingStep, toast?: ToastCode, extra: Record<string, string> = {}): never {
  revalidatePath("/onboarding");
  redirect(toast ? withToast(stepPath(step, extra), toast) : stepPath(step, extra));
}

function orgErrorPath(err: unknown): string {
  if (err instanceof OrgError) return `/onboarding?step=workspace&error=${err.code}`;
  throw err;
}

/** Step 1: create a workspace and make it active. */
export async function createWorkspace(formData: FormData) {
  const session = await requireUser();
  let orgId: string;
  try {
    orgId = (await createOrg(db(), { name: String(formData.get("name") ?? ""), createdBy: session.userId })).id;
  } catch (err) {
    redirect(orgErrorPath(err));
  }
  await setActiveOrg(db(), { sessionId: session.id, userId: session.userId, orgId });
  revalidatePath("/", "layout");
  go("install", "onboarding.workspace");
}

/** Step 1: continue in one of the user's existing workspaces. */
export async function chooseWorkspace(formData: FormData) {
  const session = await requireUser();
  const ok = await setActiveOrg(db(), { sessionId: session.id, userId: session.userId, orgId: String(formData.get("orgId") ?? "") });
  if (!ok) redirect("/onboarding?step=workspace&error=not_member");
  revalidatePath("/", "layout");
  go("install", "onboarding.workspace");
}

/** Step 1: accept an invitation addressed to the user and continue in that workspace. */
export async function acceptWorkspaceInvitation(formData: FormData) {
  const session = await requireUser();
  let orgId: string;
  try {
    ({ orgId } = await acceptInvitationById(db(), {
      invitationId: Number(formData.get("invitationId")),
      user: { id: session.userId, email: session.user.email, githubLogin: session.user.githubLogin },
      now: new Date(),
    }));
  } catch (err) {
    redirect(orgErrorPath(err));
  }
  await setActiveOrg(db(), { sessionId: session.id, userId: session.userId, orgId });
  revalidatePath("/", "layout");
  go("install", "onboarding.workspace");
}

/** Step 2: connect an installation that arrived before anyone claimed it, after GitHub confirms the user's access. */
export async function connectInstallation(formData: FormData) {
  const ctx = await requireOrg({ permission: "repos.manage" });
  const config = authConfig();
  const outcome = await connectPendingInstallation(
    {
      db: db(),
      host: webhookGitHost(),
      apiUrl: config.githubApiUrl,
      now: new Date(),
      enqueue: (rows) => enqueueIndexForNewRepos(rows),
    },
    ctx,
    Number(formData.get("installationId")),
  );
  if (outcome.status === "reauthorize") redirect(`/api/auth/github?next=${encodeURIComponent("/onboarding?step=install")}`);
  if (outcome.status === "connected") go("repos", "onboarding.connected");
  if (outcome.status === "forbidden") go("install");
  go("install", `onboarding.${outcome.status}`);
}

/** Step 3: reviews on for the checked repositories, off for the rest; newly enabled ones are queued for indexing. */
export async function saveRepoSelection(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const ids = formData.getAll("repoId").map(Number);
  if (!ids.some((n) => Number.isSafeInteger(n) && n > 0)) go("repos", "onboarding.no_repos");
  const result = await setEnabledRepos(db(), orgId, ids);
  await enqueueIndexForNewRepos(result.turnedOn, bullQueue, { requestedBy: userId });
  log.info("onboarding repository selection saved", { orgId, userId, enabled: result.enabled, turnedOff: result.turnedOff });
  revalidatePath("/dashboard/repos");
  go(result.enabled > 0 ? "configure" : "repos", result.enabled > 0 ? "onboarding.repos_saved" : "onboarding.no_repos");
}

/** Step 4: org-wide review defaults (merged into `orgs.settings`). */
export async function saveOnboardingDefaults(formData: FormData) {
  const { orgId, role } = await requireOrg({ permission: "settings.manage" });
  const state = await saveOrgSettingsForm(db(), { orgId, role }, formData, { merge: true });
  if (state.status !== "saved") go("configure", "onboarding.defaults_invalid");
  revalidatePath("/dashboard/settings");
  go("indexing", "onboarding.defaults_saved");
}

/** Step 5: retry a failed index run. */
export async function retryIndexing(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const repoId = Number(formData.get("repoId"));
  if (!Number.isSafeInteger(repoId) || repoId <= 0) go("indexing");
  let job: Awaited<ReturnType<typeof queueManualIndex>>;
  try {
    job = await queueManualIndex({ db: db(), queue: bullQueue }, { orgId, repoId, kind: "full", requestedBy: userId });
  } catch (err) {
    log.error("could not queue an index retry", { orgId, repoId, error: errorMessage(err) });
    throw err;
  }
  go("indexing", job ? "onboarding.index_queued" : "repo.not_found");
}

/** Step 6: review an existing pull request now. */
export async function reviewExistingPullRequest(formData: FormData) {
  const ctx = await requireOrg({ permission: "reviews.trigger" });
  const outcome = await requestManualReview({ db: db(), queue: bullQueue }, ctx, { repoId: formData.get("repoId"), prNumber: formData.get("prNumber") });
  if (outcome.status !== "queued") redirect(`/onboarding?step=ready&review=${outcome.status}`);
  redirect(withToast(`/dashboard/reviews/${outcome.reviewId}`, "onboarding.review_queued"));
}

/** Step 6: finish onboarding for the org (owners and admins) and go to the dashboard. */
export async function finishOnboarding() {
  const { orgId } = await requireOrg({ permission: "settings.manage" });
  await completeOnboarding(db(), orgId);
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
