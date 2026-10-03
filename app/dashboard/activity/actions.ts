"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { auditDashboard } from "@/lib/audit/dashboard";
import { getDelivery } from "@/lib/data/deliveries";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { webhookGitHost } from "@/lib/git/host";
import { bullQueue } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import { safeReturnPath, withToast } from "@/lib/ui/toast";
import { replayBitbucketDelivery } from "@/lib/webhooks/bitbucket";
import { replayDelivery } from "@/lib/webhooks/github";
import { replayGitLabDelivery } from "@/lib/webhooks/gitlab";

/** Replays a failed webhook delivery from its stored payload (R6.21); admins only. */
export async function replayDeliveryAction(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const deliveryId = String(formData.get("deliveryId") ?? "");
  const back = safeReturnPath(formData.get("returnTo"), `/dashboard/activity/${encodeURIComponent(deliveryId)}`);
  if (!/^[\w.-]{1,128}$/.test(deliveryId)) redirect(withToast("/dashboard/activity", "delivery.not_found"));
  const e = env();
  const deps = { db: db(), queue: bullQueue, host: webhookGitHost(), botMention: e.BOT_MENTION, log: log.child({ component: "webhooks", replay: true }) };
  // Each provider replays through its own router (R3.6); the delivery row says which host sent it.
  const delivery = await getDelivery(deps.db, orgId, deliveryId);
  const result =
    delivery?.provider === "gitlab"
      ? await replayGitLabDelivery(deps, orgId, deliveryId, { requestedBy: userId })
      : delivery?.provider === "bitbucket"
        ? await replayBitbucketDelivery(deps, orgId, deliveryId, { requestedBy: userId })
        : await replayDelivery({ ...deps, appSlug: e.GITHUB_APP_SLUG }, orgId, deliveryId, { requestedBy: userId });
  await auditDashboard({ orgId, userId }, { action: "delivery.replayed", targetType: "webhook_delivery", targetId: deliveryId, metadata: { outcome: result.status, provider: delivery?.provider ?? "github" } });
  revalidatePath("/dashboard/activity");
  const code =
    result.status === "not_found"
      ? "delivery.not_found"
      : result.status === "not_replayable"
        ? "delivery.not_replayable"
        : result.status === "failed"
          ? "delivery.replay_failed"
          : "delivery.replayed";
  redirect(withToast(back, code));
}
