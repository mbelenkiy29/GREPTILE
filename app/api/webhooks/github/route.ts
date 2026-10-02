import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import { bullQueue } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";

export const dynamic = "force-dynamic";

export const POST = createGitHubWebhookHandler(() => {
  const e = env();
  return {
    db: db(),
    queue: bullQueue,
    host: gitHost(),
    secret: e.GITHUB_WEBHOOK_SECRET,
    botMention: e.BOT_MENTION,
    appSlug: e.GITHUB_APP_SLUG,
    log: log.child({ component: "webhooks" }),
  };
});
