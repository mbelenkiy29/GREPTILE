"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { auditDashboard } from "@/lib/audit/dashboard";
import { appUrl, authConfig } from "@/lib/auth/config";
import { db } from "@/lib/db";
import { changeMemberRole, createInvitation, leaveOrg, parseInviteTarget, regenerateInvitationLink, removeMember, revokeInvitation } from "@/lib/data/members";
import { OrgError, type OrgErrorCode } from "@/lib/data/orgs";
import type { InviteFormState } from "./InviteForm";
import type { InviteLinkState } from "./InviteLinkButton";

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
    const { token, invitation } = await createInvitation(db(), {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      target,
      role: String(formData.get("role") ?? "member"),
      now: new Date(),
    });
    await auditDashboard(ctx, {
      action: "invitation.created",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { email: invitation.email, githubLogin: invitation.githubLogin, role: invitation.role },
    });
    revalidatePath("/dashboard/team");
    return { link: appUrl(authConfig(), `/invite/${token}`), target: target.githubLogin ? `@${target.githubLogin}` : (target.email ?? null) };
  } catch (err) {
    if (err instanceof OrgError) return { error: err.message };
    throw err;
  }
}

/** A fresh link for a pending invitation (the old link stops working); shown once. */
export async function newInviteLink(_prev: InviteLinkState, formData: FormData): Promise<InviteLinkState> {
  const ctx = await requireOrg({ permission: "members.invite" });
  try {
    const invitationId = Number(formData.get("invitationId"));
    const { token } = await regenerateInvitationLink(db(), { orgId: ctx.orgId, actorId: ctx.userId, invitationId, now: new Date() });
    await auditDashboard(ctx, { action: "invitation.link_regenerated", targetType: "invitation", targetId: invitationId });
    revalidatePath("/dashboard/team");
    return { link: appUrl(authConfig(), `/invite/${token}`) };
  } catch (err) {
    if (err instanceof OrgError) return { error: err.message };
    throw err;
  }
}

export async function revokeInvite(formData: FormData) {
  const ctx = await requireOrg({ permission: "members.invite" });
  const invitationId = Number(formData.get("invitationId"));
  done(
    await attempt(async () => {
      await revokeInvitation(db(), { orgId: ctx.orgId, actorId: ctx.userId, invitationId, now: new Date() });
      await auditDashboard(ctx, { action: "invitation.revoked", targetType: "invitation", targetId: invitationId });
    }),
  );
}

export async function changeRole(formData: FormData) {
  const ctx = await requireOrg({ permission: "members.changeRole" });
  const targetUserId = String(formData.get("userId") ?? "");
  done(
    await attempt(async () => {
      const role = await changeMemberRole(db(), { orgId: ctx.orgId, actorId: ctx.userId, targetUserId, role: String(formData.get("role") ?? "") });
      await auditDashboard(ctx, { action: "member.role_changed", targetType: "user", targetId: targetUserId, metadata: { role } });
    }),
  );
}

export async function removeFromOrg(formData: FormData) {
  const ctx = await requireOrg({ permission: "members.remove" });
  const targetUserId = String(formData.get("userId") ?? "");
  done(
    await attempt(async () => {
      await removeMember(db(), { orgId: ctx.orgId, actorId: ctx.userId, targetUserId });
      await auditDashboard(ctx, { action: targetUserId === ctx.userId ? "member.left" : "member.removed", targetType: "user", targetId: targetUserId });
    }),
  );
}

/** Any member can leave, except the last owner and the creator of a personal workspace. */
export async function leaveCurrentOrg() {
  const ctx = await requireOrg();
  const error = await attempt(async () => {
    await leaveOrg(db(), { orgId: ctx.orgId, userId: ctx.userId });
    await auditDashboard(ctx, { action: "member.left", targetType: "user", targetId: ctx.userId });
  });
  if (error) redirect(`/dashboard/team?error=${error}`);
  revalidatePath("/", "layout");
  redirect("/orgs");
}
