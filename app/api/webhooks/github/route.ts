import { db } from "@/lib/db";
import { enterpriseEnv, env } from "@/lib/env";
import { webhookGitHost } from "@/lib/git/host";
import { bullQueue } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import { publicLimiter } from "@/lib/security/rate-limit";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";

export const dynamic = "force-dynamic";

export const POST = createGitHubWebhookHandler(() => {
  const e = env();
  return {
    db: db(),
    queue: bullQueue,
    host: webhookGitHost(),
    secret: e.GITHUB_WEBHOOK_SECRET,
    botMention: e.BOT_MENTION,
    appSlug: e.GITHUB_APP_SLUG,
    log: log.child({ component: "webhooks" }),
    rateLimit: { limiter: publicLimiter(), perMinute: enterpriseEnv().WEBHOOK_RATE_LIMIT_PER_MINUTE },
  };
});
