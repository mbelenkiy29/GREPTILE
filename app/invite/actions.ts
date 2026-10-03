"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { setActiveOrg } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { acceptInvitation } from "@/lib/data/members";
import { OrgError, type OrgErrorCode } from "@/lib/data/orgs";
import { checkRateLimit } from "@/lib/security/rate-limit";

/**
 * Accepts an invitation link (R6.1). Needs a signed-in user, not an org role: the data layer checks the token hash,
 * that the invitation is still pending, and that it was addressed to this user (when it names an email or login).
 */
export async function acceptInviteAction(formData: FormData) {
  const session = await requireUser();
  const token = String(formData.get("token") ?? "");
  // Invitation acceptance is rate limited per user (R6.20).
  if (await checkRateLimit("invite.accept", session.userId)) redirect(`/invite/${encodeURIComponent(token)}?error=rate_limited`);
  let result: { orgId: string } | { error: OrgErrorCode };
  try {
    result = await acceptInvitation(db(), {
      token,
      user: { id: session.userId, email: session.user.email, githubLogin: session.user.githubLogin },
      now: new Date(),
    });
  } catch (err) {
    if (!(err instanceof OrgError)) throw err;
    result = { error: err.code };
  }
  if ("error" in result) redirect(`/invite/${encodeURIComponent(token)}?error=${result.error}`);
  await setActiveOrg(db(), { sessionId: session.id, userId: session.userId, orgId: result.orgId });
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
