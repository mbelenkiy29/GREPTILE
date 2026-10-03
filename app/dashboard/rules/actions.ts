"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { auditDashboard } from "@/lib/audit/dashboard";
import { db } from "@/lib/db";
import { applyRuleTemplate, deleteRule, reviewCandidateRule, RuleValidationError, saveRuleForm, setRuleEnabled } from "@/lib/data/rules";
import type { RuleFormState } from "@/lib/rules/form-state";
import { safeReturnPath, withToast } from "@/lib/ui/toast";

/*
 * Rules (R2.1, R2.5, R6.11). Every action needs `rules.manage`; the org comes from the session and every rule id is
 * looked up within it.
 */

const RULES = "/dashboard/rules";

function ruleIdOf(formData: FormData): number | null {
  const n = Number(formData.get("ruleId"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function back(formData: FormData) {
  return safeReturnPath(formData.get("returnTo"), RULES);
}

/** Creates a rule, or updates `ruleId` (create/edit form). Validation errors come back to the form inline. */
export async function saveRule(_prev: RuleFormState, formData: FormData): Promise<RuleFormState> {
  const ctx = await requireOrg({ permission: "rules.manage" });
  const state = await saveRuleForm(db(), ctx, formData);
  if (state.status !== "saved") return state;
  const editing = Boolean(formData.get("ruleId"));
  await auditDashboard(ctx, {
    action: editing ? "rule.updated" : "rule.created",
    targetType: "rule",
    targetId: state.ruleId ?? null,
  });
  revalidatePath(RULES);
  redirect(withToast(RULES, formData.get("ruleId") ? "rule.saved" : "rule.created"));
}

/** Turns a rule on or off. */
export async function toggleRule(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  const ruleId = ruleIdOf(formData);
  const enabled = formData.get("enabled") === "true";
  const row = ruleId === null ? undefined : await setRuleEnabled(db(), orgId, ruleId, enabled);
  if (row) await auditDashboard({ orgId, userId }, { action: enabled ? "rule.enabled" : "rule.disabled", targetType: "rule", targetId: ruleId });
  revalidatePath(RULES);
  redirect(withToast(back(formData), !row ? "rule.not_found" : enabled ? "rule.enabled" : "rule.disabled"));
}

export async function removeRule(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  const ruleId = ruleIdOf(formData);
  const deleted = ruleId !== null && (await deleteRule(db(), orgId, ruleId));
  if (deleted) await auditDashboard({ orgId, userId }, { action: "rule.deleted", targetType: "rule", targetId: ruleId });
  revalidatePath(RULES);
  redirect(withToast(RULES, deleted ? "rule.deleted" : "rule.not_found"));
}

/** Approves or dismisses a rule mined from teammates' review comments (R2.5). */
export async function reviewCandidate(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  const ruleId = ruleIdOf(formData);
  const decision = formData.get("decision") === "approve" ? "approve" : "reject";
  const row = ruleId === null ? undefined : await reviewCandidateRule(db(), orgId, ruleId, decision);
  if (row) await auditDashboard({ orgId, userId }, { action: decision === "approve" ? "rule.approved" : "rule.rejected", targetType: "rule", targetId: ruleId });
  revalidatePath(RULES);
  redirect(withToast(back(formData), !row ? "rule.not_found" : decision === "approve" ? "rule.approved" : "rule.dismissed"));
}

/** Adds a starter template as an org-wide rule (or for `repoId`). */
export async function addTemplate(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  const repoRaw = String(formData.get("repoId") ?? "").trim();
  try {
    const templateId = String(formData.get("templateId") ?? "");
    const rule = await applyRuleTemplate(db(), orgId, { templateId, repoId: repoRaw ? Number(repoRaw) : null, createdBy: userId });
    await auditDashboard({ orgId, userId }, { action: "rule.created", targetType: "rule", targetId: rule.id, metadata: { template: templateId, repositoryId: rule.repoId } });
  } catch (err) {
    if (err instanceof RuleValidationError) redirect(withToast(RULES, "rule.invalid"));
    throw err;
  }
  revalidatePath(RULES);
  redirect(withToast(RULES, "rule.template_added"));
}
