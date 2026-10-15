"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { backend, current } from "../../../src/server";
import { isConfigureStep, nextStep, stepSettingsFromForm, type WizardStep } from "../../../src/onboarding-steps";

type Result = { error?: string; message?: string };
const text = (form: FormData, key: string) => z.string().parse(form.get(key) ?? "");
const organizationOf = (form: FormData) => text(form, "organizationId") as Id<"organizations">;
const failure = (error: unknown, fallback: string): Result => ({ error: error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0].slice(0, 300) : fallback });

export async function createSetupWorkspace(_state: Result, form: FormData): Promise<Result> {
  let id: string;
  try {
    const { token } = await current();
    id = await backend().mutation(api.users.createOrganization, { token, name: text(form, "name") });
  } catch (error) { return failure(error, "Could not create the workspace"); }
  (await cookies()).set("openreview_workspace", id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  redirect("/dashboard/onboarding/connect");
}

// Save the repository selection and start indexing; automatic reviews wait for the triggers step.
export async function selectAndIndex(_state: Result, form: FormData): Promise<Result> {
  try {
    const { token } = await current(), organizationId = organizationOf(form);
    const repositoryIds = form.getAll("repositoryIds").map(String) as Id<"repositories">[];
    if (!repositoryIds.length) return { error: "Select at least one repository to continue." };
    await backend().mutation(api.onboarding.select, { token, organizationId, repositoryIds });
    await backend().mutation(api.onboarding.start, { token, organizationId, pauseReviews: true });
    await backend().mutation(api.onboarding.advance, { token, organizationId, step: "connect" });
  } catch (error) { return failure(error, "Could not start indexing"); }
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/onboarding/indexing");
}

export async function saveSetupStep(_state: Result, form: FormData): Promise<Result> {
  const step = text(form, "step");
  if (!isConfigureStep(step)) return { error: "Unknown setup step" };
  try {
    const { token } = await current(), organizationId = organizationOf(form);
    const { defaults } = await backend().query(api.onboarding.status, { token, organizationId });
    await backend().mutation(api.onboarding.saveDefaults, { token, organizationId, step, settings: stepSettingsFromForm(step, form, defaults) });
    if (step === "tools" && form.get("agent")) await backend().mutation(api.bridge.saveWorkspaceAgent, { token, organizationId, agent: z.enum(["codex", "claude", "cursor"]).parse(text(form, "agent")) });
  } catch (error) { return failure(error, "Could not save these settings"); }
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard/onboarding/${nextStep(step)}`);
}

export async function advanceSetup(_state: Result, form: FormData): Promise<Result> {
  const step = text(form, "step") as WizardStep;
  try {
    const { token } = await current();
    await backend().mutation(api.onboarding.advance, { token, organizationId: organizationOf(form), step });
  } catch (error) { return failure(error, "Could not continue"); }
  redirect(`/dashboard/onboarding/${nextStep(step) ?? "done"}`);
}

export async function inviteFromSetup(_state: Result, form: FormData): Promise<Result> {
  const login = text(form, "login").trim().replace(/^@/, "");
  if (!login) return { error: "Enter a GitHub username." };
  try {
    const { token } = await current();
    await backend().mutation(api.users.invite, { token, organizationId: organizationOf(form), githubLogin: login, role: z.enum(["admin", "member", "viewer"]).parse(text(form, "role")) });
  } catch (error) { return failure(error, "Could not send the invitation"); }
  revalidatePath("/dashboard/onboarding/team");
  return { message: `Invited @${login}. They accept from their own OpenReview dashboard.` };
}

export async function finishSetup(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.onboarding.complete, { token, organizationId: organizationOf(form), skipped: form.get("skipped") === "true" });
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/analytics");
}
