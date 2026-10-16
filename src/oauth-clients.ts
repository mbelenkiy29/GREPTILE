import { api } from "../convex/_generated/api";
import { backend } from "./server";
import { clientMetadataUrl, loadClientMetadata, type MetadataFetcher, safeMetadataFetch } from "./oauth-server";

// Resolves an OAuth client: a URL client_id is a Client ID Metadata Document (fetched with SSRF guards,
// cached for an hour); anything else must have been registered dynamically.
export async function resolveClient(clientId: string, fetcher: MetadataFetcher = safeMetadataFetch): Promise<{ client: { clientId: string; name: string; redirectUris: string[] } } | { error: string }> {
  const secret = process.env.SERVICE_SECRET ?? "";
  const cached = await backend().query(api.oauth.client, { secret, clientId });
  if (clientMetadataUrl(clientId)) {
    if (cached?.kind === "metadata" && (cached.fetchedAt ?? 0) > Date.now() - 3_600_000) return { client: { clientId, name: cached.name, redirectUris: cached.redirectUris } };
    const loaded = await loadClientMetadata(clientId, fetcher);
    if ("error" in loaded) return { error: loaded.error ?? "Invalid client" };
    await backend().mutation(api.oauth.saveClient, { secret, clientId, name: loaded.client.name, redirectUris: loaded.client.redirectUris, kind: "metadata" });
    return loaded;
  }
  if (cached?.kind === "registered") return { client: { clientId, name: cached.name, redirectUris: cached.redirectUris } };
  return { error: "Unknown client_id. Use a Client ID Metadata Document URL or register the client first." };
}
