/**
 * Links to repositories, pull requests, commits, files, and comments on the repository's own host (R3.6). GitHub,
 * GitLab (`/-/merge_requests/…`, `/-/blob/…`), and Bitbucket Cloud (`/pull-requests/…`, `/src/…`) lay out their web
 * URLs differently; every dashboard link goes through these helpers instead of assuming GitHub.
 */

/** Where a repository lives on the web: its provider and the host's web origin. */
export interface RepoWeb {
  provider: string;
  /** Web origin (`https://github.com`, `https://gitlab.example.com`, `https://bitbucket.org`). */
  webUrl: string;
}

export const DEFAULT_WEB_URLS: Record<string, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  bitbucket: "https://bitbucket.org",
};

/**
 * The web location of a repository's host: the installation's own web URL (self-managed GitLab, GitHub Enterprise
 * via `fallbackGithubUrl`) or the provider's default.
 */
export function repoWeb(provider: string | null | undefined, installationWebUrl?: string | null, fallbackGithubUrl?: string): RepoWeb {
  const p = provider ?? "github";
  const base = installationWebUrl || (p === "github" ? fallbackGithubUrl : undefined) || DEFAULT_WEB_URLS[p] || DEFAULT_WEB_URLS.github!;
  return { provider: p, webUrl: base.replace(/\/+$/, "") };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function repoUrl(web: RepoWeb, repoFullName: string): string {
  return `${web.webUrl}/${repoFullName}`;
}

export function prUrl(web: RepoWeb, repoFullName: string, prNumber: number): string {
  if (web.provider === "gitlab") return `${repoUrl(web, repoFullName)}/-/merge_requests/${prNumber}`;
  if (web.provider === "bitbucket") return `${repoUrl(web, repoFullName)}/pull-requests/${prNumber}`;
  return `${repoUrl(web, repoFullName)}/pull/${prNumber}`;
}

export function commitUrl(web: RepoWeb, repoFullName: string, sha: string): string {
  if (web.provider === "gitlab") return `${repoUrl(web, repoFullName)}/-/commit/${sha}`;
  if (web.provider === "bitbucket") return `${repoUrl(web, repoFullName)}/commits/${sha}`;
  return `${repoUrl(web, repoFullName)}/commit/${sha}`;
}

export function blobUrl(web: RepoWeb, repoFullName: string, sha: string, path: string, line?: number): string {
  const p = encodePath(path);
  if (web.provider === "gitlab") return `${repoUrl(web, repoFullName)}/-/blob/${sha}/${p}${line ? `#L${line}` : ""}`;
  if (web.provider === "bitbucket") return `${repoUrl(web, repoFullName)}/src/${sha}/${p}${line ? `#lines-${line}` : ""}`;
  return `${repoUrl(web, repoFullName)}/blob/${sha}/${p}${line ? `#L${line}` : ""}`;
}

/** Link to an inline comment on its pull request. */
export function commentUrl(web: RepoWeb, repoFullName: string, prNumber: number, commentId: number): string {
  if (web.provider === "gitlab") return `${prUrl(web, repoFullName, prNumber)}#note_${commentId}`;
  if (web.provider === "bitbucket") return `${prUrl(web, repoFullName, prNumber)}#comment-${commentId}`;
  return `${prUrl(web, repoFullName, prNumber)}#discussion_r${commentId}`;
}

/** Provider display names. */
export const PROVIDER_LABEL: Record<string, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket" };
