"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteLearnedPattern, updateLearnedPattern } from "@/lib/learning";

export async function editPattern(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "rules.manage" });
  const signal = String(formData.get("signal"));
  await updateLearnedPattern(db(), orgId, Number(formData.get("id")), {
    description: String(formData.get("description") ?? ""),
    ...(signal === "suppress" || signal === "boost" || signal === "neutral" ? { signal } : {}),
  });
  revalidatePath("/dashboard/learned");
}

export async function removePattern(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "rules.manage" });
  await deleteLearnedPattern(db(), orgId, Number(formData.get("id")));
  revalidatePath("/dashboard/learned");
}
