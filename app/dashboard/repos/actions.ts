"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRepo, setRepoEnabled, updateRepoSettings } from "@/lib/data/installations";
import { bullQueue } from "@/lib/jobs/queue";

export async function toggleRepo(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "repos.manage" });
  await setRepoEnabled(db(), orgId, Number(formData.get("repoId")), formData.get("enabled") === "true");
  revalidatePath("/dashboard/repos");
}

export async function reindexRepo(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "repos.manage" });
  const repo = await getRepo(db(), orgId, Number(formData.get("repoId")));
  if (!repo) return;
  await bullQueue.add("index-repo", { orgId, repoId: repo.id, mode: "full" }, { jobId: `index-${repo.id}-manual-${Date.now()}` });
  revalidatePath("/dashboard/repos");
}

function lines(v: FormDataEntryValue | null) {
  return String(v ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function saveRepoSettings(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "settings.manage" });
  const repoId = Number(formData.get("repoId"));
  const commentTypes = formData.getAll("commentTypes").map(String) as ("logic" | "security" | "style")[];
  await updateRepoSettings(db(), orgId, repoId, {
    strictness: String(formData.get("strictness")) as "low" | "medium" | "high",
    commentTypes: commentTypes.length ? commentTypes : undefined,
    ignore: lines(formData.get("ignore")),
    context: lines(formData.get("context")),
  });
  revalidatePath(`/dashboard/repos/${repoId}`);
}
