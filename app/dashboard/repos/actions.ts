"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { saveRepoSettingsForm, type SettingsFormState } from "@/lib/config/settings-form";
import { db } from "@/lib/db";
import { getRepo, setRepoEnabled } from "@/lib/data/installations";
import { cancelIndexJob, queueManualIndex } from "@/lib/indexer/jobs";
import { bullQueue } from "@/lib/jobs/queue";
import { errorMessage, log } from "@/lib/log";
import { safeReturnPath, withToast } from "@/lib/ui/toast";

function repoIdOf(formData: FormData): number | null {
  const n = Number(formData.get("repoId"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function back(formData: FormData) {
  return safeReturnPath(formData.get("returnTo"), "/dashboard/repos");
}

/** Turns reviews on or off for a repository (R6.13). */
export async function toggleRepo(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "repos.manage" });
  const repoId = repoIdOf(formData);
  const repo = repoId === null ? undefined : await getRepo(db(), orgId, repoId);
  if (!repo) redirect(withToast(back(formData), "repo.not_found"));
  const enable = formData.get("enabled") === "true";
  if (enable && repo.archived) redirect(withToast(back(formData), "repo.archived"));
  await setRepoEnabled(db(), orgId, repo.id, enable);
  revalidatePath("/dashboard/repos");
  redirect(withToast(back(formData), enable ? "repo.enabled" : "repo.disabled"));
}

/** Queues a tracked full or incremental index run of a repository (R6.3). */
export async function reindexRepo(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const repoId = repoIdOf(formData);
  const repo = repoId === null ? undefined : await getRepo(db(), orgId, repoId);
  if (!repo) redirect(withToast(back(formData), "repo.not_found"));
  const kind = formData.get("kind") === "incremental" ? "incremental" : "full";
  let job;
  try {
    job = await queueManualIndex({ db: db(), queue: bullQueue }, { orgId, repoId: repo.id, kind, requestedBy: userId });
  } catch (err) {
    log.error("could not queue manual re-index", { orgId, repoId: repo.id, error: errorMessage(err) });
    throw err;
  }
  if (!job) redirect(withToast(back(formData), "repo.not_found"));
  log.info("manual re-index queued", { orgId, repoId: repo.id, indexJobId: job.id, kind, requestedBy: userId });
  revalidatePath("/dashboard/repos");
  redirect(withToast(back(formData), "index.queued"));
}

/** Cancels a queued or running index run (R6.3). */
export async function cancelIndex(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const repoId = repoIdOf(formData);
  const jobId = Number(formData.get("jobId"));
  if (repoId === null || !Number.isSafeInteger(jobId)) redirect(withToast(back(formData), "repo.not_found"));
  const cancelled = await cancelIndexJob(db(), orgId, repoId, jobId);
  if (cancelled) log.info("index run cancelled", { orgId, repoId, indexJobId: jobId, requestedBy: userId });
  revalidatePath("/dashboard/repos");
  redirect(withToast(back(formData), cancelled ? "index.cancelled" : "index.not_running"));
}

/** Saves a repository's review settings (R6.14); validation errors come back to the form inline. */
export async function saveRepoSettings(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const { orgId, role } = await requireOrg({ permission: "settings.manage" });
  const state = await saveRepoSettingsForm(db(), { orgId, role }, formData);
  if (state.status === "saved") revalidatePath(`/dashboard/repos/${String(formData.get("repoId"))}`);
  return state;
}
