"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { auditDashboard } from "@/lib/audit/dashboard";
import { db } from "@/lib/db";
import { deletePreference, parseResetForm, PreferenceError, resetPreferences, updatePreference } from "@/lib/learning/preferences";
import { withToast } from "@/lib/ui/toast";

/* Learned preferences (R2.4, R6.10). Every action needs `rules.manage`; the org comes from the session. */

const PATH = "/dashboard/learned";

function idOf(formData: FormData): number | null {
  const n = Number(formData.get("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Edits a preference's description and signal; any edit pins it. */
export async function editPattern(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  const id = idOf(formData);
  const signal = String(formData.get("signal"));
  let row;
  try {
    row =
      id === null
        ? undefined
        : await updatePreference(db(), orgId, id, {
            description: String(formData.get("description") ?? ""),
            ...(signal === "suppress" || signal === "boost" || signal === "neutral" ? { signal } : {}),
          });
  } catch (err) {
    if (err instanceof PreferenceError) redirect(withToast(PATH, "preference.invalid"));
    throw err;
  }
  if (row) await auditDashboard({ orgId, userId }, { action: "preference.updated", targetType: "preference", targetId: id });
  revalidatePath(PATH);
  redirect(withToast(PATH, row ? "preference.saved" : "preference.not_found"));
}

export async function removePattern(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  const id = idOf(formData);
  const deleted = id !== null && (await deletePreference(db(), orgId, id));
  if (deleted) await auditDashboard({ orgId, userId }, { action: "preference.deleted", targetType: "preference", targetId: id });
  revalidatePath(PATH);
  redirect(withToast(PATH, deleted ? "preference.deleted" : "preference.not_found"));
}

/** Forgets learned preferences (all, or one repository's), keeping pinned ones unless `includePinned`. */
export async function resetAllPreferences(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  try {
    const opts = parseResetForm(formData);
    const { deleted } = await resetPreferences(db(), orgId, opts);
    await auditDashboard({ orgId, userId }, { action: "preference.reset", targetType: opts.repoId ? "repository" : "org", targetId: opts.repoId ?? orgId, metadata: { deleted, includePinned: opts.includePinned } });
  } catch (err) {
    if (err instanceof PreferenceError) redirect(withToast(PATH, "preference.not_found"));
    throw err;
  }
  revalidatePath(PATH);
  redirect(withToast(PATH, "preferences.reset"));
}
