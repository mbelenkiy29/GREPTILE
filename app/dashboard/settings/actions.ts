"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { saveOrgSettingsForm, type SettingsFormState } from "@/lib/config/settings-form";
import { db } from "@/lib/db";
import { deleteOrg, OrgError, renameOrg } from "@/lib/data/orgs";
import { log } from "@/lib/log";
import { withToast } from "@/lib/ui/toast";

/** Renames the org and/or changes its slug (owners and admins). */
export async function renameOrganization(formData: FormData) {
  const ctx = await requireOrg({ permission: "org.update" });
  try {
    await renameOrg(db(), { orgId: ctx.orgId, actorId: ctx.userId, name: String(formData.get("name") ?? ""), slug: String(formData.get("slug") ?? "") });
  } catch (err) {
    if (err instanceof OrgError) redirect(`/dashboard/settings?error=${err.code}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(withToast("/dashboard/settings", "org.renamed"));
}

/** Deletes the org and everything in it (owners only, typed confirmation, never a personal workspace). */
export async function deleteOrganization(formData: FormData) {
  const ctx = await requireOrg({ permission: "org.delete" });
  try {
    await deleteOrg(db(), { orgId: ctx.orgId, actorId: ctx.userId, confirm: String(formData.get("confirm") ?? "") });
  } catch (err) {
    if (err instanceof OrgError) redirect(`/dashboard/settings?error=${err.code}`);
    throw err;
  }
  log.warn("organization deleted", { orgId: ctx.orgId, userId: ctx.userId });
  revalidatePath("/", "layout");
  redirect("/orgs");
}

/** Saves the org's review defaults (R6.14); validation errors come back to the form inline. */
export async function saveOrgDefaults(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const { orgId, role } = await requireOrg({ permission: "settings.manage" });
  const state = await saveOrgSettingsForm(db(), { orgId, role }, formData);
  if (state.status === "saved") revalidatePath("/dashboard/settings/review");
  return state;
}
