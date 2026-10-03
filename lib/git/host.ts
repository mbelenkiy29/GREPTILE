import { BitbucketHost } from "@/lib/bitbucket/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { GitHubHost } from "@/lib/github/client";
import { GitLabHost } from "@/lib/gitlab/client";
import { LocalGitHost } from "@/lib/git/local/host";
import { localModeBlocker } from "@/lib/git/local/guard";
import { bitbucketConnection, gitlabConnection } from "@/lib/scm/connection";
import { GitHosts } from "./hosts";

export { clientFor, GitHosts, hostFor, UnsupportedProviderError } from "./hosts";

/** Longest the webhook route waits on a GitHub rate limit or retry: GitHub abandons a delivery after 10 s. */
export const WEBHOOK_GITHUB_MAX_WAIT_MS = 2_000;

let hosts: GitHosts | undefined;
let webhookHosts: GitHosts | undefined;

function create(maxWaitMs?: number) {
  const e = env();
  const wait = maxWaitMs !== undefined ? { maxWaitMs } : {};
  const github = new GitHubHost({ appId: e.GITHUB_APP_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY, apiUrl: e.GITHUB_API_URL, webUrl: e.GITHUB_WEB_URL, ...wait });
  return new GitHosts(github, {
    gitlab: new GitLabHost({ credentials: (id) => gitlabConnection(db(), id), ...wait }),
    bitbucket: new BitbucketHost({ credentials: (id) => bitbucketConnection(db(), id), ...wait }),
    // Demo / local mode (R6.22) only: without DEMO_MODE (or in production) `local` installations get UnsupportedProviderError.
    ...(localModeBlocker(e) === null ? { local: new LocalGitHost({ db, root: e.LOCAL_GIT_ROOT, mode: e }) } : {}),
  });
}

/** The git hosts for background jobs: they wait up to a minute for rate limits before failing. */
export function gitHost(): GitHosts {
  hosts ??= create();
  return hosts;
}

/**
 * The git hosts for code that runs inside a webhook request or a page: they fail fast instead of sleeping on a rate
 * limit, so a delivery is recorded as failed (and can be redelivered or replayed) rather than timing out at the host.
 */
export function webhookGitHost(): GitHosts {
  webhookHosts ??= create(WEBHOOK_GITHUB_MAX_WAIT_MS);
  return webhookHosts;
}
