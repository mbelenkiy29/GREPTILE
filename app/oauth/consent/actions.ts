"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { apiScopes } from "../../../src/api-scopes";
import { pendingAuthorization } from "../../../src/oauth-consent";
import { newSecret, redirectWith, tokenHash } from "../../../src/oauth-server";
import { backend, current } from "../../../src/server";

// Approve: one workspace, the scopes the user kept (never more than requested, bounded by role on the
// server), a single-use code bound to the client, redirect URI, PKCE challenge and resource.
export async function approveAuthorization(form: FormData) {
  const pending = await pendingAuthorization();
  if (!pending) redirect("/oauth/consent");
  const { token } = await current();
  const organizationId = z.string().parse(form.get("organizationId")) as Id<"organizations">;
  const scopes = form.getAll("scopes").map(String).filter((s): s is (typeof apiScopes)[number] => (pending.scopes as string[]).includes(s));
  const code = newSecret("orx_");
  await backend().mutation(api.oauth.approve, { token, organizationId, clientId: pending.clientId, clientName: pending.clientName, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge, resource: pending.resource, scopes: scopes.length ? scopes : ["read"], hash: tokenHash(code) });
  (await cookies()).delete({ name: "openreview_oauth_request", path: "/oauth" });
  redirect(redirectWith(pending.redirectUri, { code, state: pending.state, iss: pending.issuer }));
}
export async function denyAuthorization() {
  const pending = await pendingAuthorization();
  if (!pending) redirect("/oauth/consent");
  (await cookies()).delete({ name: "openreview_oauth_request", path: "/oauth" });
  redirect(redirectWith(pending.redirectUri, { error: "access_denied", error_description: "The user declined access", state: pending.state, iss: pending.issuer }));
}
