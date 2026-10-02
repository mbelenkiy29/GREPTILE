import { env } from "@/lib/env";
import { GitHubHost } from "@/lib/github/client";
import type { GitHost } from "./types";

let github: GitHubHost | undefined;

export function gitHost(): GitHost {
  const e = env();
  github ??= new GitHubHost({ appId: e.GITHUB_APP_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY, apiUrl: e.GITHUB_API_URL });
  return github;
}
