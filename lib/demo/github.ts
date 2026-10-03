/**
 * Read-only access to public github.com data for the demo (R3.7). Only GET requests exist here, so a demo can never
 * write to GitHub. Unauthenticated by default; DEMO_GITHUB_TOKEN (no scopes needed) only raises the rate limit.
 */
import { outboundFetch } from "@/lib/net/fetch";
import { z } from "zod";

export const PUBLIC_GITHUB_API = "https://api.github.com";
export const PUBLIC_GITHUB_WEB = "https://github.com";

const repoSchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
  /** Kilobytes, as GitHub reports it. */
  size: z.number().min(0),
  default_branch: z.string(),
});

const prSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), ref: z.string() }),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  changed_files: z.number().int().min(0),
});

const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  patch: z.string().optional(),
});

export type PublicRepo = z.infer<typeof repoSchema>;
export type PublicPullRequest = z.infer<typeof prSchema>;
export type PublicPrFile = z.infer<typeof fileSchema>;

export class PublicGitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublicGitHubError";
  }
}

export interface PublicGitHubOptions {
  fetch?: typeof fetch;
  token?: string;
  apiUrl?: string;
  timeoutMs?: number;
}

export class PublicGitHub {
  private readonly fetch: typeof fetch;
  private readonly api: string;

  constructor(private readonly opts: PublicGitHubOptions = {}) {
    // The public GitHub API host comes from GITHUB_API_URL, which the outbound allowlist always permits (R4.6).
    this.fetch = opts.fetch ?? outboundFetch;
    this.api = opts.apiUrl ?? PUBLIC_GITHUB_API;
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "OpenReview-demo",
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    const res = await this.fetch(`${this.api}${path}`, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000) });
    if (!res.ok) {
      const limited = (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
      throw new PublicGitHubError(res.status, limited ? "GitHub's API rate limit was reached" : `GitHub answered ${res.status} for ${path}`);
    }
    return schema.parse(await res.json());
  }

  getRepo(owner: string, repo: string): Promise<PublicRepo> {
    return this.get(`/repos/${owner}/${repo}`, repoSchema);
  }

  getPullRequest(owner: string, repo: string, number: number): Promise<PublicPullRequest> {
    return this.get(`/repos/${owner}/${repo}/pulls/${number}`, prSchema);
  }

  /** The PR's changed files with patches, up to `max` files (GitHub lists at most 3000). */
  async listPullRequestFiles(owner: string, repo: string, number: number, max: number): Promise<PublicPrFile[]> {
    const out: PublicPrFile[] = [];
    for (let page = 1; out.length < max && page <= 30; page++) {
      const batch = await this.get(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`, z.array(fileSchema));
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out.slice(0, max);
  }
}

/** HTTPS clone URL of a public repository (no credentials). */
export function publicCloneUrl(owner: string, repo: string): string {
  return `${PUBLIC_GITHUB_WEB}/${owner}/${repo}.git`;
}
