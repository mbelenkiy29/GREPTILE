import { DEMO_PROVIDER } from "@/lib/demo/ids";
import type { GitClient, GitHost, RemoteInstallation, RemoteRepo } from "./types";

export class UnsupportedProviderError extends Error {
  constructor(readonly provider: string) {
    super(
      provider === DEMO_PROVIDER
        ? `the public demo's placeholder installation (provider "${provider}") has no git host`
        : `no git host is configured for provider "${provider}"`,
    );
    this.name = "UnsupportedProviderError";
  }
}

/**
 * Every configured git host, by provider (R3.6). It is itself the GitHub host (the default provider, so GitHub-only
 * code such as the App install flow keeps working with it); {@link hostFor} picks the host for an installation's
 * provider.
 */
export class GitHosts implements GitHost {
  readonly provider: string;

  constructor(
    private readonly primary: GitHost,
    private readonly others: Record<string, GitHost> = {},
  ) {
    this.provider = primary.provider;
  }

  forProvider(provider: string): GitHost {
    if (provider === DEMO_PROVIDER) throw new UnsupportedProviderError(provider);
    if (provider === this.primary.provider) return this.primary;
    const host = this.others[provider];
    if (!host) throw new UnsupportedProviderError(provider);
    return host;
  }

  getInstallation(installationId: number): Promise<RemoteInstallation> {
    return this.primary.getInstallation(installationId);
  }

  listInstallationRepos(installationId: number): Promise<RemoteRepo[]> {
    return this.primary.listInstallationRepos(installationId);
  }

  client(installationId: number): GitClient {
    return this.primary.client(installationId);
  }
}

/**
 * The host serving `provider` (an `installations.provider`): the provider's host from a {@link GitHosts}, or `host`
 * itself when it is that provider's host (tests pass a single host).
 */
export function hostFor(host: GitHost, provider: string): GitHost {
  // The demo org's installation (R3.7) only anchors its repos; it never talks to a git host.
  if (provider === DEMO_PROVIDER) throw new UnsupportedProviderError(provider);
  if (host instanceof GitHosts) return host.forProvider(provider);
  if (host.provider === provider) return host;
  throw new UnsupportedProviderError(provider);
}

/** The API client for one installation: `hostFor(host, installation.provider).client(installation.externalId)`. */
export function clientFor(host: GitHost, installation: { provider: string; externalId: number }): GitClient {
  return hostFor(host, installation.provider).client(installation.externalId);
}
