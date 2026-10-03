"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormResult } from "@/components/enterprise/StatefulForm";
import { getSession, requireOrg } from "@/lib/auth";
import { dashboardActor } from "@/lib/audit/dashboard";
import { db } from "@/lib/db";
import { enterpriseEnv } from "@/lib/env";
import { checkSsoConnection } from "@/lib/sso/check";
import {
  createSsoConnection,
  deleteSsoConnection,
  getSsoConnection,
  normalizeIssuer,
  parseSsoForm,
  setSsoConnectionEnabled,
  setSsoEnforcement,
  SsoConfigError,
  updateSsoConnection,
} from "@/lib/sso/connections";
import { SsoError } from "@/lib/sso/errors";
import { assertSsoUrl } from "@/lib/sso/net";
import { clearOidcCache } from "@/lib/sso/oidc";
import { withToast } from "@/lib/ui/toast";

/* Single sign-on settings (R4.6). Every action needs `sso.manage` (owners); connections are looked up in the session's org. */

const PATH = "/dashboard/settings/sso";

function net() {
  return { allowPrivate: enterpriseEnv().SSO_ALLOW_PRIVATE_ISSUERS };
}

function idOf(formData: FormData): string {
  return String(formData.get("connectionId") ?? "").slice(0, 64);
}

/** Creates a connection, or updates `connectionId`. The issuer / SSO URL must pass the SSRF guard. */
export async function saveSsoConnectionAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const ctx = await requireOrg({ permission: "sso.manage" });
  if (ctx.personal) return { error: "Single sign-on is for team organizations, not personal workspaces." };
  const id = idOf(formData);
  const existing = id ? await getSsoConnection(db(), ctx.orgId, id) : undefined;
  if (id && !existing) return { error: "That connection isn't in this organization." };
  try {
    const input = parseSsoForm(formData, existing);
    if (input.protocol === "oidc") await assertSsoUrl(`${normalizeIssuer(input.issuer)}/.well-known/openid-configuration`, net(), "The issuer URL");
    else if (input.samlSsoUrl) await assertSsoUrl(input.samlSsoUrl, net(), "The IdP SSO URL");
    const actor = await dashboardActor(ctx);
    if (existing) {
      await updateSsoConnection(db(), actor, existing.id, input);
      clearOidcCache(existing.issuer);
    } else {
      await createSsoConnection(db(), actor, input);
    }
  } catch (err) {
    if (err instanceof SsoConfigError || err instanceof SsoError) return { error: err.message };
    throw err;
  }
  revalidatePath(PATH);
  redirect(withToast(PATH, existing ? "sso.saved" : "sso.created"));
}

/** Checks discovery / keys (OIDC) or the SSO URL and certificates (SAML) without signing anyone in. */
export async function testSsoConnectionAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const ctx = await requireOrg({ permission: "sso.manage" });
  const connection = await getSsoConnection(db(), ctx.orgId, idOf(formData));
  if (!connection) return { error: "That connection isn't in this organization." };
  return checkSsoConnection(connection, net());
}

export async function toggleSsoConnectionAction(formData: FormData) {
  const ctx = await requireOrg({ permission: "sso.manage" });
  const enable = formData.get("enabled") === "true";
  const row = await setSsoConnectionEnabled(db(), await dashboardActor(ctx), idOf(formData), enable);
  revalidatePath(PATH);
  redirect(withToast(PATH, !row ? "sso.not_found" : enable ? "sso.enabled" : "sso.disabled"));
}

/** Requires (or stops requiring) SSO; requiring it needs the owner's own session to have signed in through it. */
export async function setSsoEnforcementAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const ctx = await requireOrg({ permission: "sso.manage" });
  const session = await getSession();
  const enforce = formData.get("enforce") === "true";
  let row;
  try {
    row = await setSsoEnforcement(db(), { ...(await dashboardActor(ctx)), actorHasSso: Boolean(session?.ssoOrgIds.includes(ctx.orgId)) }, idOf(formData), enforce);
  } catch (err) {
    if (err instanceof SsoConfigError) return { error: err.message };
    throw err;
  }
  revalidatePath(PATH);
  redirect(withToast(PATH, !row ? "sso.not_found" : enforce ? "sso.enforced" : "sso.not_enforced"));
}

export async function deleteSsoConnectionAction(formData: FormData) {
  const ctx = await requireOrg({ permission: "sso.manage" });
  const deleted = await deleteSsoConnection(db(), await dashboardActor(ctx), idOf(formData));
  revalidatePath(PATH);
  redirect(withToast(PATH, deleted ? "sso.deleted" : "sso.not_found"));
}
