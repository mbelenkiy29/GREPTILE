"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { saveRepoSettingsForm, type SettingsFormState } from "@/lib/config/settings-form";
import { db } from "@/lib/db";
import { getRepo, setRepoEnabled } from "@/lib/data/installations";
import { cancelIndexJob, createIndexJob } from "@/lib/indexer/jobs";
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
  const job = await createIndexJob(db(), { orgId, repoId: repo.id, kind, trigger: "manual" });
  const queueJobId = `index-${repo.id}-manual-${job.id}`;
  try {
    await bullQueue.add(
      "index-repo",
      { orgId, repoId: repo.id, mode: kind, trigger: "manual", indexJobId: job.id, meta: { requestedBy: userId } },
      { jobId: queueJobId },
    );
  } catch (err) {
    // Never leave a tracked run queued that no worker will pick up.
    await cancelIndexJob(db(), orgId, repo.id, job.id);
    log.error("could not queue manual re-index", { orgId, repoId: repo.id, indexJobId: job.id, error: errorMessage(err) });
    throw err;
  }
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
