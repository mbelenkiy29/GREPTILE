"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { setActiveOrg } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { acceptInvitationById } from "@/lib/data/members";
import { createOrg, OrgError, type OrgErrorCode } from "@/lib/data/orgs";
import { checkRateLimit } from "@/lib/security/rate-limit";

/*
 * Org selection (R6.1). These act on the signed-in user's own memberships rather than on an org's data, so they
 * need a signed-in user, not an org role: the data layer verifies membership (switch) or invitation addressing
 * (accept) before anything changes.
 */

async function attempt<T>(fn: () => Promise<T>): Promise<T | { error: OrgErrorCode }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OrgError) return { error: err.code };
    throw err;
  }
}

/** Makes another of the user's orgs active; refused unless they are a member. */
export async function switchOrg(formData: FormData) {
  const session = await requireUser();
  const orgId = String(formData.get("orgId") ?? "");
  const ok = await setActiveOrg(db(), { sessionId: session.id, userId: session.userId, orgId });
  if (!ok) redirect("/orgs?error=not_member");
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/** Creates an org owned by the user and switches to it. */
export async function createOrgAction(formData: FormData) {
  const session = await requireUser();
  const result = await attempt(() => createOrg(db(), { name: String(formData.get("name") ?? ""), createdBy: session.userId }));
  if ("error" in result) redirect(`/orgs?error=${result.error}`);
  await setActiveOrg(db(), { sessionId: session.id, userId: session.userId, orgId: result.id });
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/** Accepts an invitation addressed to the user's email or GitHub login and switches to that org. */
export async function acceptListedInvitation(formData: FormData) {
  const session = await requireUser();
  if (await checkRateLimit("invite.accept", session.userId)) redirect("/orgs?error=rate_limited");
  const result = await attempt(() =>
    acceptInvitationById(db(), {
      invitationId: Number(formData.get("invitationId")),
      user: { id: session.userId, email: session.user.email, githubLogin: session.user.githubLogin },
      now: new Date(),
    }),
  );
  if ("error" in result) redirect(`/orgs?error=${result.error}`);
  await setActiveOrg(db(), { sessionId: session.id, userId: session.userId, orgId: result.orgId });
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
