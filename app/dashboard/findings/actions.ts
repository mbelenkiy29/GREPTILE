"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { auditDashboard } from "@/lib/audit/dashboard";
import { db } from "@/lib/db";
import { FeedbackError, parseFeedbackForm, retractFeedback, submitFindingFeedback, type FeedbackResult } from "@/lib/data/feedback";
import { parseResetForm, PreferenceError, resetPreferences } from "@/lib/learning/preferences";

export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Useful / not useful / resolved / won't fix / false positive on a finding, from the dashboard (R6.10). */
export async function giveFindingFeedback(formData: FormData): Promise<ActionResult<FeedbackResult>> {
  const { orgId, userId } = await requireOrg({ permission: "findings.feedback" });
  try {
    const input = parseFeedbackForm(formData);
    const result = await submitFindingFeedback(db(), { ...input, orgId, userId, source: "dashboard" });
    await auditDashboard({ orgId, userId }, { action: "finding.feedback_given", targetType: "finding", targetId: input.findingId, metadata: { kind: input.kind } });
    revalidatePath("/dashboard/findings");
    revalidatePath("/dashboard/reviews", "layout");
    revalidatePath("/dashboard/learned");
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof FeedbackError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Takes back the signed-in user's own feedback (`feedbackId`). */
export async function retractFindingFeedback(formData: FormData): Promise<ActionResult<{ retracted: boolean; status?: string }>> {
  const { orgId, userId } = await requireOrg({ permission: "findings.feedback" });
  const feedbackId = Number(formData.get("feedbackId"));
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) return { ok: false, error: "Invalid feedback." };
  const res = await retractFeedback(db(), { orgId, feedbackId, userId });
  if (res.retracted) {
    await auditDashboard({ orgId, userId }, { action: "finding.feedback_retracted", targetType: "finding", targetId: res.finding?.id ?? null, metadata: { feedbackId } });
  }
  revalidatePath("/dashboard/findings");
  revalidatePath("/dashboard/reviews", "layout");
  revalidatePath("/dashboard/learned");
  return { ok: true, retracted: res.retracted, ...(res.finding ? { status: res.finding.status } : {}) };
}

/** Forgets learned preferences (R6.10): the org's or one repository's, keeping pinned ones unless asked. */
export async function resetLearnedPreferences(formData: FormData): Promise<ActionResult<{ deleted: number }>> {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  try {
    const opts = parseResetForm(formData);
    const result = await resetPreferences(db(), orgId, opts);
    await auditDashboard({ orgId, userId }, { action: "preference.reset", targetType: opts.repoId ? "repository" : "org", targetId: opts.repoId ?? orgId, metadata: { deleted: result.deleted, includePinned: opts.includePinned } });
    revalidatePath("/dashboard/learned");
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof PreferenceError) return { ok: false, error: err.message };
    throw err;
  }
}
