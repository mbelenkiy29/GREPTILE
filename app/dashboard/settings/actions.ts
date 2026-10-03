"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { auditDashboard } from "@/lib/audit/dashboard";
import { saveOrgSettingsForm, type SettingsFormState } from "@/lib/config/settings-form";
import { db } from "@/lib/db";
import { deleteOrg, OrgError, renameOrg } from "@/lib/data/orgs";
import { log } from "@/lib/log";
import { withToast } from "@/lib/ui/toast";

/** Renames the org and/or changes its slug (owners and admins). */
export async function renameOrganization(formData: FormData) {
  const ctx = await requireOrg({ permission: "org.update" });
  let renamed;
  try {
    renamed = await renameOrg(db(), { orgId: ctx.orgId, actorId: ctx.userId, name: String(formData.get("name") ?? ""), slug: String(formData.get("slug") ?? "") });
  } catch (err) {
    if (err instanceof OrgError) redirect(`/dashboard/settings?error=${err.code}`);
    throw err;
  }
  await auditDashboard(ctx, {
    action: "org.renamed",
    targetType: "org",
    targetId: ctx.orgId,
    metadata: { from: { name: ctx.orgName, slug: ctx.orgSlug }, to: { name: renamed.name, slug: renamed.slug } },
  });
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
  // The org's audit log is deleted with it (every tenant row cascades); the structured log keeps the record.
  log.warn("organization deleted", { orgId: ctx.orgId, orgSlug: ctx.orgSlug, userId: ctx.userId, audit: "org.deleted" });
  revalidatePath("/", "layout");
  redirect("/orgs");
}

/** Saves the org's review defaults (R6.14); validation errors come back to the form inline. */
export async function saveOrgDefaults(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const { orgId, role, userId } = await requireOrg({ permission: "settings.manage" });
  const state = await saveOrgSettingsForm(db(), { orgId, role }, formData);
  if (state.status === "saved") {
    await auditDashboard({ orgId, userId }, { action: "settings.org_updated", targetType: "org", targetId: orgId });
    revalidatePath("/dashboard/settings/review");
  }
  return state;
}
