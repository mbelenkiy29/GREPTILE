import { env } from "@/lib/env";
import { GitHubHost } from "@/lib/github/client";
import type { GitHost } from "./types";

/** Longest the webhook route waits on a GitHub rate limit or retry: GitHub abandons a delivery after 10 s. */
export const WEBHOOK_GITHUB_MAX_WAIT_MS = 2_000;

let github: GitHubHost | undefined;
let webhookGithub: GitHubHost | undefined;

function create(maxWaitMs?: number) {
  const e = env();
  return new GitHubHost({
    appId: e.GITHUB_APP_ID,
    privateKey: e.GITHUB_APP_PRIVATE_KEY,
    apiUrl: e.GITHUB_API_URL,
    webUrl: e.GITHUB_WEB_URL,
    ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
  });
}

/** The git host for background jobs: waits up to a minute for rate limits before failing. */
export function gitHost(): GitHost {
  github ??= create();
  return github;
}

/**
 * The git host for code that runs inside the GitHub webhook request: it fails fast instead of sleeping on a rate limit,
 * so the delivery is recorded as failed (and can be redelivered or replayed) rather than timing out on GitHub's side.
 */
export function webhookGitHost(): GitHost {
  webhookGithub ??= create(WEBHOOK_GITHUB_MAX_WAIT_MS);
  return webhookGithub;
}
