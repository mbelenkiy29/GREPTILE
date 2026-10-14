import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { current, backend, origin, unseal } from "../../../../../src/server";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

export async function GET(request: Request) {
  const identity = await current(), jar = await cookies(), cookie = jar.get("openreview_atlassian_oauth")?.value;
  jar.delete("openreview_atlassian_oauth");
  let connection: Id<"integrationConnections">;
  try {
    if (!cookie) throw new Error("Expired session");
    const saved = z.object({state:z.string(), organizationId:z.string(), userId:z.string(), expiresAt:z.number()}).parse(await unseal(cookie));
    const params = new URL(request.url).searchParams, code = params.get("code");
    if (params.get("error") || !code || params.get("state") !== saved.state || saved.userId !== identity.user._id || saved.expiresAt <= Date.now() || !identity.organizations.some(o=>o._id===saved.organizationId&&["owner","admin"].includes(o.role))) throw new Error("Invalid authorization");
    connection = await backend().action(api.atlassianJobs.connect, {token:identity.token, secret:process.env.SERVICE_SECRET??"", organizationId:saved.organizationId as Id<"organizations">, code, redirectUri:origin()+"/api/integrations/atlassian/callback", jti:"atlassian:"+saved.state, expiresAt:saved.expiresAt});
  } catch {
    // OAuth responses may contain credentials or private provider data; never echo them.
    return NextResponse.redirect(origin()+"/dashboard/memory/integrations?error=atlassian-connect");
  }
  return NextResponse.redirect(origin()+"/dashboard/memory/integrations?integration="+connection);
}
