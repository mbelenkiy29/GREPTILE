import { BitbucketHost } from "@/lib/bitbucket/client";
import { db } from "@/lib/db";
import { scmEnv } from "@/lib/env";
import { webhookGitHost } from "@/lib/git/host";
import { GitLabHost } from "@/lib/gitlab/client";
import { bullQueue } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import type { ScmDeps } from "./connections";

/** Production dependencies for connecting GitLab / Bitbucket and enabling their repositories (R3.6). */
export function productionScmDeps(): ScmDeps {
  const e = scmEnv();
  const hosts = webhookGitHost();
  const gitlab = hosts.forProvider("gitlab");
  const bitbucket = hosts.forProvider("bitbucket");
  if (!(gitlab instanceof GitLabHost) || !(bitbucket instanceof BitbucketHost)) throw new Error("GitLab and Bitbucket hosts are not configured");
  return {
    db: db(),
    gitlab,
    bitbucket,
    queue: bullQueue,
    appUrl: e.APP_URL,
    gitlabUrl: e.GITLAB_URL,
    bitbucketApiUrl: e.BITBUCKET_API_URL,
    log: log.child({ component: "scm" }),
  };
}
