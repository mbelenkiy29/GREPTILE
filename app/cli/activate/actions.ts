"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { decideLogin, formatUserCode, normalizeUserCode } from "@/lib/cli/device";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * Approves or denies an `openreview login` (R3.5). Needs a signed-in user; approving also needs membership in the
 * chosen org (checked in `decideLogin`, never trusted from the form). Server actions only run for same-origin
 * requests, so another site cannot approve a login on the user's behalf.
 */
export async function decideCliLoginAction(formData: FormData) {
  const session = await requireUser();
  const decision = formData.get("decision") === "approve" ? "approve" : "deny";
  const rawCode = formData.get("code");
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  const result = await decideLogin(db(), {
    userCode: rawCode,
    userId: session.userId,
    decision,
    orgId: String(formData.get("orgId") ?? "") || null,
    ip,
    now: new Date(),
  });
  if (!result.ok) {
    const code = normalizeUserCode(rawCode);
    redirect(`/cli/activate?${new URLSearchParams({ ...(code ? { code: formatUserCode(code) } : {}), error: result.error })}`);
  }
  log.info(result.status === "approved" ? "CLI login approved" : "CLI login denied", {
    userId: session.userId,
    orgId: result.session.orgId,
    cliSessionId: result.session.id,
  });
  redirect(`/cli/activate?done=${result.status}&host=${encodeURIComponent(result.session.clientHost)}`);
}
