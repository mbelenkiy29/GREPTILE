import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { webhookGitHost } from "@/lib/git/host";
import { bullQueue } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import { createBitbucketWebhookHandler } from "@/lib/webhooks/bitbucket";

export const dynamic = "force-dynamic";

export const POST = createBitbucketWebhookHandler(() => ({
  db: db(),
  queue: bullQueue,
  host: webhookGitHost(),
  botMention: env().BOT_MENTION,
  log: log.child({ component: "webhooks" }),
}));
