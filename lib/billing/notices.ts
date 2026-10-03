/**
 * One-time pull request comments for reviews skipped by a usage limit (R4.3, R4.2). A webhook-triggered review that
 * a cap or the free plan turns away is recorded as a skipped run; the PR gets one comment explaining why per limit
 * reason and usage period, so later pushes to the same PR stay quiet.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { usageLimitNotices } from "@/lib/db/schema";
import type { GitClient } from "@/lib/git/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import type { UsagePeriod } from "./account";
import type { LimitCode } from "./limits";

export const LIMIT_NOTICE_MARKER = "<!-- openreview:usage-limit -->";

export function limitNoticeBody(code: LimitCode, reason: string): string {
  const title = code === "usage_cap" ? "OpenReview skipped this review: usage cap reached" : "OpenReview skipped this review: free plan limit";
  return `**${title}**\n\n${reason}\n\n<sub>This note is posted once per pull request per billing period.</sub>\n\n${LIMIT_NOTICE_MARKER}`;
}

/**
 * Posts the limit comment on the PR unless this PR already got one for `code` in `period`. Returns true when a
 * comment was posted. A failed post releases the claim so a later event can try again; it never throws.
 */
export async function postLimitNotice(
  db: Db,
  client: Pick<GitClient, "createIssueComment">,
  input: { orgId: string; repoId: number; repoFullName: string; prNumber: number; code: LimitCode; reason: string; period: UsagePeriod },
  log: Logger = rootLog,
): Promise<boolean> {
  const [claimed] = await db
    .insert(usageLimitNotices)
    .values({ orgId: input.orgId, repoId: input.repoId, prNumber: input.prNumber, reason: input.code, periodStart: input.period.start })
    .onConflictDoNothing()
    .returning({ id: usageLimitNotices.id });
  if (!claimed) return false;
  try {
    const comment = await client.createIssueComment(input.repoFullName, input.prNumber, limitNoticeBody(input.code, input.reason));
    await db
      .update(usageLimitNotices)
      .set({ commentId: comment.id })
      .where(and(eq(usageLimitNotices.orgId, input.orgId), eq(usageLimitNotices.id, claimed.id)));
    log.info("usage limit notice posted", { orgId: input.orgId, repoId: input.repoId, prNumber: input.prNumber, code: input.code });
    return true;
  } catch (err) {
    await db
      .delete(usageLimitNotices)
      .where(and(eq(usageLimitNotices.orgId, input.orgId), eq(usageLimitNotices.id, claimed.id)))
      .catch(() => undefined);
    log.warn("could not post the usage limit notice", { orgId: input.orgId, repoId: input.repoId, prNumber: input.prNumber, error: errorMessage(err) });
    return false;
  }
}
