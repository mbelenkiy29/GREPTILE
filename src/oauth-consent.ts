import { cookies } from "next/headers";
import { z } from "zod";
import { apiScopes } from "./api-scopes";
import { unseal } from "./server";

// The validated authorization request, sealed by /oauth/authorize for the consent page (10 minutes).
export const pendingSchema = z.object({ clientId: z.string(), clientName: z.string(), redirectUri: z.string().url(), codeChallenge: z.string(), scopes: z.array(z.enum(apiScopes)).min(1), state: z.string().optional(), resource: z.string().url(), issuer: z.string().url() });
export async function pendingAuthorization() {
  const sealed = (await cookies()).get("openreview_oauth_request")?.value;
  if (!sealed) return null;
  try { return pendingSchema.parse(await unseal(sealed)); } catch { return null; }
}
