"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { appUrl, authConfig } from "@/lib/auth/config";
import { db } from "@/lib/db";
import { changeMemberRole, createInvitation, leaveOrg, parseInviteTarget, removeMember, revokeInvitation } from "@/lib/data/members";
import { OrgError, type OrgErrorCode } from "@/lib/data/orgs";
import type { InviteFormState } from "./InviteForm";

/*
 * Team management (R6.1). Each action checks the role permission here and the data layer re-checks the acting
 * user's role, the owner rules, and the last-owner rule inside a transaction.
 */

async function attempt(fn: () => Promise<unknown>): Promise<OrgErrorCode | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof OrgError) return err.code;
    throw err;
  }
}

function done(error: OrgErrorCode | null) {
  revalidatePath("/dashboard/team");
  if (error) redirect(`/dashboard/team?error=${error}`);
}

/** Creates an invitation and returns its link (shown once; only the token hash is stored). */
export async function inviteMember(_prev: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const ctx = await requireOrg({ permission: "members.invite" });
  try {
    const target = parseInviteTarget(String(formData.get("target") ?? ""));
    const { token } = await createInvitation(db(), {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      target,
      role: String(formData.get("role") ?? "member"),
      now: new Date(),
    });
    revalidatePath("/dashboard/team");
    return { link: appUrl(authConfig(), `/invite/${token}`), target: target.githubLogin ? `@${target.githubLogin}` : (target.email ?? null) };
  } catch (err) {
    if (err instanceof OrgError) return { error: err.message };
    throw err;
  }
}

export async function revokeInvite(formData: FormData) {
  const ctx = await requireOrg({ permission: "members.invite" });
  done(
    await attempt(() =>
      revokeInvitation(db(), { orgId: ctx.orgId, actorId: ctx.userId, invitationId: Number(formData.get("invitationId")), now: new Date() }),
    ),
  );
}

export async function changeRole(formData: FormData) {
  const ctx = await requireOrg({ permission: "members.changeRole" });
  done(
    await attempt(() =>
      changeMemberRole(db(), {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        targetUserId: String(formData.get("userId") ?? ""),
        role: String(formData.get("role") ?? ""),
      }),
    ),
  );
}

export async function removeFromOrg(formData: FormData) {
  const ctx = await requireOrg({ permission: "members.remove" });
  done(await attempt(() => removeMember(db(), { orgId: ctx.orgId, actorId: ctx.userId, targetUserId: String(formData.get("userId") ?? "") })));
}

/** Any member can leave, except the last owner. */
export async function leaveCurrentOrg() {
  const ctx = await requireOrg();
  const error = await attempt(() => leaveOrg(db(), { orgId: ctx.orgId, userId: ctx.userId }));
  if (error) redirect(`/dashboard/team?error=${error}`);
  revalidatePath("/", "layout");
  redirect("/orgs");
}
