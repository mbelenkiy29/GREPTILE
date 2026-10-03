"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { editKnowledgeDescription, getKnowledgeEntry, knowledgeEnabled, KnowledgeEditError, latestKnowledgeRuns, resolveKnowledgeProposal } from "@/lib/data/knowledge";
import { getRepo } from "@/lib/data/installations";
import { bullQueue } from "@/lib/jobs/queue";
import { queueKnowledgeRefresh, STALE_RUN_MS } from "@/lib/knowledge/refresh";
import { log } from "@/lib/log";
import { safeReturnPath, withToast } from "@/lib/ui/toast";

function idOf(formData: FormData, key: string): number | null {
  const n = Number(formData.get(key));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function back(formData: FormData) {
  return safeReturnPath(formData.get("returnTo"), "/dashboard/knowledge");
}

/**
 * Queues a regeneration (R6.12): every entry of a repository (`scope=all`) or one entry (`entryId`). Admins only.
 * The repository (and entry) are looked up in the signed-in org; client-supplied ids never cross tenants.
 */
export async function regenerateKnowledge(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const entryId = idOf(formData, "entryId");
  const entry = entryId === null ? null : await getKnowledgeEntry(db(), orgId, entryId);
  if (entryId !== null && !entry) redirect(withToast(back(formData), "knowledge.not_found"));
  const repoId = entry?.repo.id ?? idOf(formData, "repoId");
  const repo = repoId === null ? undefined : await getRepo(db(), orgId, repoId);
  if (!repo) redirect(withToast(back(formData), "repo.not_found"));
  if (!knowledgeEnabled()) redirect(withToast(back(formData), "knowledge.disabled"));
  if (!repo.indexedSha) redirect(withToast(back(formData), "knowledge.not_indexed"));
  // One pending refresh per repository: repeated clicks never queue more model calls. A pending run older than the
  // abandoned-run window (its job was lost) no longer blocks a new one.
  const { latest } = await latestKnowledgeRuns(db(), orgId, repo.id);
  const pending = latest && (latest.status === "queued" || latest.status === "running") && Date.now() - (latest.startedAt ?? latest.createdAt).getTime() < STALE_RUN_MS;
  if (pending) redirect(withToast(back(formData), "knowledge.busy"));
  const run = await queueKnowledgeRefresh(db(), bullQueue, {
    orgId,
    repoId: repo.id,
    trigger: "manual",
    mode: entry ? "entry" : "all",
    ...(entry ? { slug: entry.entry.slug } : {}),
    meta: { requestedBy: userId },
  });
  log.info("knowledge regeneration queued", { orgId, repoId: repo.id, knowledgeRunId: run.id, slug: entry?.entry.slug, requestedBy: userId });
  revalidatePath("/dashboard/knowledge");
  redirect(withToast(back(formData), "knowledge.queued"));
}

/** Saves a person's description of an entry (marks it `edited`). Admins only. */
export async function saveKnowledgeDescription(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const id = idOf(formData, "entryId");
  if (id === null) redirect(withToast(back(formData), "knowledge.not_found"));
  let saved;
  try {
    saved = await editKnowledgeDescription(db(), orgId, { id, description: formData.get("description"), userId });
  } catch (err) {
    if (err instanceof KnowledgeEditError) redirect(withToast(back(formData), "knowledge.invalid"));
    throw err;
  }
  if (!saved) redirect(withToast(back(formData), "knowledge.not_found"));
  log.info("knowledge entry edited", { orgId, knowledgeEntryId: id, requestedBy: userId });
  revalidatePath(`/dashboard/knowledge/${id}`);
  redirect(withToast(back(formData), "knowledge.saved"));
}

/** Accepts (`decision=accept`) or rejects a proposed regeneration of an edited entry. Admins only. */
export async function decideKnowledgeProposal(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const id = idOf(formData, "entryId");
  if (id === null) redirect(withToast(back(formData), "knowledge.not_found"));
  const accept = formData.get("decision") === "accept";
  const row = await resolveKnowledgeProposal(db(), orgId, { id, accept });
  if (!row) redirect(withToast(back(formData), "knowledge.no_proposal"));
  log.info("knowledge proposal resolved", { orgId, knowledgeEntryId: id, accepted: accept, requestedBy: userId });
  revalidatePath(`/dashboard/knowledge/${id}`);
  redirect(withToast(back(formData), accept ? "knowledge.accepted" : "knowledge.rejected"));
}
