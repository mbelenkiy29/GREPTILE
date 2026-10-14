import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { current, backend, origin, unseal } from "../../../../src/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export async function GET(request: Request) {
  const identity = await current(), jar = await cookies(), cookie = jar.get("openreview_slack_oauth")?.value;
  jar.delete("openreview_slack_oauth");
  try {
    if (!cookie) throw new Error("Expired session");
    const saved = z.object({ state: z.string(), organizationId: z.string(), userId: z.string(), expiresAt: z.number() }).parse(await unseal(cookie));
    const params = new URL(request.url).searchParams, code = params.get("code");
    if (params.get("error") || !code || code.length > 500 || params.get("state") !== saved.state || saved.userId !== identity.user._id || saved.expiresAt <= Date.now() || !identity.organizations.some((o) => o._id === saved.organizationId && ["owner", "admin"].includes(o.role))) throw new Error("Invalid authorization");
    await backend().action(api.notificationJobs.installSlack, { token: identity.token, secret: process.env.SERVICE_SECRET ?? "", organizationId: saved.organizationId as Id<"organizations">, code, redirectUri: origin() + "/api/slack/callback", jti: "slack:" + saved.state, expiresAt: saved.expiresAt });
  } catch {
    // OAuth responses may contain credentials; never echo them.
    return NextResponse.redirect(origin() + "/dashboard/settings/notifications?slack=error");
  }
  return NextResponse.redirect(origin() + "/dashboard/settings/notifications?slack=connected");
}
