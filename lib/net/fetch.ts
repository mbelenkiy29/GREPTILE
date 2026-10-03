/**
 * The one door for server-side outbound HTTP (R4.6 offline bundle, R6.20). Every production `fetch` to another host
 * goes through {@link outboundFetch} (or a fetch made by {@link createOutboundFetch}), which checks the target host
 * against an allowlist built from configuration:
 *
 * - the LLM endpoint (`LLM_BASE_URL`, or the provider's public API) and the embedding endpoint;
 * - the git hosts (`GITHUB_API_URL` / `GITHUB_WEB_URL`, and `GITLAB_*` / `BITBUCKET_*` URLs when configured);
 * - Stripe, only when billing is configured (`STRIPE_SECRET_KEY`);
 * - hosts a caller adds for configured, per-org endpoints (SSO issuers and their IdP endpoints, an org's own LLM);
 * - anything listed in `OUTBOUND_ALLOWLIST`.
 *
 * With `OUTBOUND_ALLOWLIST_ENFORCE=true` any other host is refused with {@link OutboundBlockedError} and an error log;
 * otherwise the call goes ahead and a warning names the host, so an operator can audit an install before enforcing.
 * Git transport (`git fetch` over https) runs through the git CLI against the same git host and is not HTTP-fetched.
 */
import { enterpriseEnv, llmEnvSchema } from "@/lib/env";
import { log as rootLog, type Logger } from "@/lib/log";

/** Public API hosts of the hosted model providers (used when no base URL is configured). */
const PROVIDER_HOSTS: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  openrouter: "openrouter.ai",
};

/** Env variables naming git host URLs; each one that is set adds its host. */
export const GIT_HOST_URL_VARS = ["GITHUB_API_URL", "GITHUB_WEB_URL", "GITLAB_URL", "GITLAB_API_URL", "BITBUCKET_URL", "BITBUCKET_API_URL"] as const;

export const STRIPE_API_HOST = "api.stripe.com";

export interface OutboundPolicy {
  enforce: boolean;
  /** Allowed host patterns, lowercase: `host`, `host:port`, or `*.domain` (subdomains of `domain`). */
  hosts: string[];
  /** Why each built-in host is allowed (for the self-hosting docs and logs). */
  reasons: Record<string, string>;
}

export class OutboundBlockedError extends Error {
  constructor(readonly host: string) {
    super(`outbound request to ${host} refused: the host is not in the outbound allowlist (OUTBOUND_ALLOWLIST)`);
    this.name = "OutboundBlockedError";
  }
}

function hostOfUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Normalizes an allowlist entry (a host, `host:port`, `*.domain`, or a URL) to a lowercase pattern. */
export function normalizeHostPattern(entry: string): string | null {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes("://")) return hostOfUrl(trimmed);
  const pattern = trimmed.replace(/\/.*$/, "").replace(/\.$/, "");
  return /^(\*\.)?[a-z0-9.\-[\]:]+$/.test(pattern) ? pattern : null;
}

/** The allowlist from the environment (see the module comment for what is always allowed). */
export function outboundPolicy(source: Record<string, string | undefined> = process.env): OutboundPolicy {
  const e = enterpriseEnv(source);
  const llm = llmEnvSchema.parse(source);
  const reasons: Record<string, string> = {};
  const add = (host: string | null | undefined, reason: string) => {
    if (host && !reasons[host]) reasons[host] = reason;
  };

  if (llm.LLM_PROVIDER !== "fake") add(hostOfUrl(llm.LLM_BASE_URL) ?? PROVIDER_HOSTS[llm.LLM_PROVIDER], "LLM endpoint");
  if (llm.EMBEDDING_PROVIDER !== "fake") {
    add(hostOfUrl(llm.EMBEDDING_BASE_URL) ?? (llm.EMBEDDING_PROVIDER === "openai" ? PROVIDER_HOSTS.openai : null), "embedding endpoint");
  }
  add(hostOfUrl(source.GITHUB_API_URL || "https://api.github.com"), "git host API");
  add(hostOfUrl(source.GITHUB_WEB_URL || "https://github.com"), "git host");
  for (const v of GIT_HOST_URL_VARS) add(hostOfUrl(source[v]), "git host");
  if (source.STRIPE_SECRET_KEY) add(STRIPE_API_HOST, "billing (Stripe)");
  for (const entry of (e.OUTBOUND_ALLOWLIST ?? "").split(",")) add(normalizeHostPattern(entry), "OUTBOUND_ALLOWLIST");

  return { enforce: e.OUTBOUND_ALLOWLIST_ENFORCE, hosts: Object.keys(reasons), reasons };
}

function defaultPort(protocol: string): string {
  return protocol === "http:" ? "80" : protocol === "https:" ? "443" : "";
}

/** Whether `url` matches one of the host patterns. A pattern without a port matches the scheme's default port only. */
export function hostAllowed(url: URL, patterns: readonly string[]): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const port = url.port || defaultPort(url.protocol);
  for (const raw of patterns) {
    const p = raw.toLowerCase();
    const colon = p.lastIndexOf(":");
    const hasPort = colon > p.lastIndexOf("]") && colon > -1;
    const pHost = hasPort ? p.slice(0, colon) : p;
    const pPort = hasPort ? p.slice(colon + 1) : defaultPort(url.protocol);
    if (pPort !== port) continue;
    if (pHost.startsWith("*.")) {
      if (hostname.endsWith(pHost.slice(1))) return true;
    } else if (pHost === hostname) {
      return true;
    }
  }
  return false;
}

export interface OutboundFetchOptions {
  /** Extra host patterns this fetch may reach (configured per-org endpoints: SSO issuers, an org's own LLM). */
  allow?: readonly string[];
  /** Policy override (tests); defaults to the environment's, read once per process. */
  policy?: OutboundPolicy;
  /** The transport the checked request is handed to (tests); defaults to the global fetch. */
  transport?: typeof fetch;
  log?: Logger;
}

let cachedPolicy: OutboundPolicy | undefined;
const warned = new Set<string>();

function currentPolicy(): OutboundPolicy {
  cachedPolicy ??= outboundPolicy();
  return cachedPolicy;
}

function urlOf(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

/** A fetch that enforces the outbound allowlist (plus `opts.allow`). */
export function createOutboundFetch(opts: OutboundFetchOptions = {}): typeof fetch {
  const extra = (opts.allow ?? []).map((h) => normalizeHostPattern(h)).filter((h): h is string => !!h);
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const policy = opts.policy ?? currentPolicy();
    const url = urlOf(input);
    const logger = (opts.log ?? rootLog).child({ component: "outbound" });
    if (!hostAllowed(url, [...policy.hosts, ...extra])) {
      if (policy.enforce) {
        logger.error("outbound request blocked by the allowlist", { host: url.host });
        throw new OutboundBlockedError(url.host);
      }
      if (!warned.has(url.host)) {
        warned.add(url.host);
        logger.warn("outbound request to a host outside the allowlist (allowed: OUTBOUND_ALLOWLIST_ENFORCE is off)", { host: url.host });
      }
    }
    return (opts.transport ?? globalThis.fetch)(input, init);
  };
  return impl as typeof fetch;
}

/** The allowlist-checked fetch for hosts that are always configured (git hosts, the LLM, Stripe). */
export const outboundFetch: typeof fetch = createOutboundFetch();
