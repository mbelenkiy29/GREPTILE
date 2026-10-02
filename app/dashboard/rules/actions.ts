"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRule, deleteRule, parsePathsInput, updateRule } from "@/lib/data/rules";

function repoIdFrom(formData: FormData) {
  const v = String(formData.get("repoId") ?? "");
  return v ? Number(v) : null;
}

export async function addRule(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "rules.manage" });
  await createRule(db(), orgId, {
    text: String(formData.get("text") ?? ""),
    repoId: repoIdFrom(formData),
    paths: parsePathsInput(String(formData.get("paths") ?? "")),
    createdBy: userId,
  });
  revalidatePath("/dashboard/rules");
}

export async function editRule(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "rules.manage" });
  await updateRule(db(), orgId, Number(formData.get("ruleId")), {
    text: String(formData.get("text") ?? ""),
    paths: parsePathsInput(String(formData.get("paths") ?? "")),
  });
  revalidatePath("/dashboard/rules");
}

export async function removeRule(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "rules.manage" });
  await deleteRule(db(), orgId, Number(formData.get("ruleId")));
  revalidatePath("/dashboard/rules");
}

export async function setRuleStatus(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "rules.manage" });
  const status = String(formData.get("status"));
  if (status !== "active" && status !== "rejected") return;
  await updateRule(db(), orgId, Number(formData.get("ruleId")), { status });
  revalidatePath("/dashboard/rules");
}
