"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormResult } from "@/components/enterprise/StatefulForm";
import { requireOrg } from "@/lib/auth";
import { dashboardActor } from "@/lib/audit/dashboard";
import { db } from "@/lib/db";
import { deleteOrgLlmSettings, LlmSettingsError, parseLlmSettingsForm, saveOrgLlmSettings } from "@/lib/data/llm-settings";
import { testModelConnection } from "@/lib/llm/connection-test";
import { gatewayForOrg, invalidateOrgGateway } from "@/lib/llm/org";
import { errorMessage } from "@/lib/log";
import { withToast } from "@/lib/ui/toast";

/* Model provider settings (R4.6). Owners and admins (`settings.manage`); the org comes from the session. */

const PATH = "/dashboard/settings/model";

export async function saveModelSettingsAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const ctx = await requireOrg({ permission: "settings.manage" });
  try {
    await saveOrgLlmSettings(db(), await dashboardActor(ctx), parseLlmSettingsForm(formData));
  } catch (err) {
    if (err instanceof LlmSettingsError) return { error: err.message };
    throw err;
  }
  invalidateOrgGateway(ctx.orgId);
  revalidatePath(PATH);
  redirect(withToast(PATH, "llm.saved"));
}

/** Sends one tiny classification call through the org's gateway (its saved provider, or the server default). */
export async function testModelSettingsAction(): Promise<FormResult> {
  const ctx = await requireOrg({ permission: "settings.manage" });
  invalidateOrgGateway(ctx.orgId);
  try {
    return await testModelConnection(await gatewayForOrg(db(), ctx.orgId), ctx.orgId);
  } catch (err) {
    return { ok: false, lines: [`Failed: ${errorMessage(err)}`] };
  }
}

export async function removeModelSettingsAction() {
  const ctx = await requireOrg({ permission: "settings.manage" });
  await deleteOrgLlmSettings(db(), await dashboardActor(ctx));
  invalidateOrgGateway(ctx.orgId);
  revalidatePath(PATH);
  redirect(withToast(PATH, "llm.removed"));
}
