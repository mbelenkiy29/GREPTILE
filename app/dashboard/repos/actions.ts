"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRepo, setRepoEnabled } from "@/lib/data/installations";
import { bullQueue } from "@/lib/jobs/queue";

export async function toggleRepo(formData: FormData) {
  const { orgId } = await requireOrg();
  await setRepoEnabled(db(), orgId, Number(formData.get("repoId")), formData.get("enabled") === "true");
  revalidatePath("/dashboard/repos");
}

export async function reindexRepo(formData: FormData) {
  const { orgId } = await requireOrg();
  const repo = await getRepo(db(), orgId, Number(formData.get("repoId")));
  if (!repo) return;
  await bullQueue.add("index-repo", { orgId, repoId: repo.id, mode: "full" }, { jobId: `index-${repo.id}-manual-${Date.now()}` });
  revalidatePath("/dashboard/repos");
}
