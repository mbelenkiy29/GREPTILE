import { createHash, randomBytes } from "node:crypto";
import { egressAllowed } from "./egress";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { apiScopes, type ApiScope } from "./api-scopes";

// OAuth 2.1 for the remote MCP endpoint, following the MCP authorization specification (2026-07-28):
// OpenReview is both the authorization server and the protected resource. Access tokens are opaque,
// bound to the MCP endpoint (RFC 8707 audience), to one workspace and user, and to D2 key scopes.
// Clients identify themselves with Client ID Metadata Documents (preferred) or, for older clients,
// Dynamic Client Registration (deprecated in the spec, still allowed).

export const oauthBase = (requestUrl: string) => (process.env.APP_URL ?? new URL(requestUrl).origin).replace(/\/+$/, "");
export const mcpResource = (base: string) => `${base}/api/mcp`;
export const resourceMetadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource/api/mcp`;
export const accessTokenSeconds = 3600, refreshTokenDays = 30, codeSeconds = 600;

export function protectedResourceMetadata(base: string) {
  return { resource: mcpResource(base), authorization_servers: [base], scopes_supported: ["read"], bearer_methods_supported: ["header"], resource_name: "OpenReview MCP" };
}
export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...apiScopes],
    client_id_metadata_document_supported: egressAllowed("oauth-client-metadata"),
    authorization_response_iss_parameter_supported: true,
  };
}
// RFC 6750 / RFC 9728 challenge for 401 and insufficient-scope 403 responses.
export function bearerChallenge(base: string, options: { error?: "invalid_token" | "insufficient_scope"; scope?: string; description?: string } = {}) {
  const parts = [`resource_metadata="${resourceMetadataUrl(base)}"`, `scope="${options.scope ?? "read"}"`];
  if (options.error) parts.unshift(`error="${options.error}"`);
  if (options.description) parts.push(`error_description="${options.description.replace(/["\\]/g, "")}"`);
  return `Bearer ${parts.join(", ")}`;
}

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const newSecret = (prefix: "ora_" | "orr_" | "orx_" | "orc_") => prefix + randomBytes(32).toString("base64url");
export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const validVerifier = (verifier: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);

// Redirect URIs: HTTPS, or http on a loopback host (native and CLI clients). No fragments or userinfo.
export function validRedirectUri(uri: string) {
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.hash || url.username || url.password || uri.length > 500) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
export const loopbackRedirect = (uri: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname);

const scopeList = z.string().max(200).transform((s) => [...new Set(s.split(" ").filter(Boolean))]).pipe(z.array(z.enum(apiScopes)).min(1));
export const authorizationRequest = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(500),
  redirect_uri: z.string().min(1).max(500),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "code_challenge must be an S256 challenge"),
  code_challenge_method: z.literal("S256"),
  scope: scopeList.optional(),
  state: z.string().max(500).optional(),
  resource: z.string().max(500).optional(),
});
export type AuthorizationRequest = z.infer<typeof authorizationRequest> & { clientName: string };

// Client ID Metadata Documents: the client_id is an HTTPS URL with a path whose JSON document lists the
// client name and redirect URIs. Fetching it is server-side request forgery surface, so the URL and the
// resolved addresses are restricted and the response is small, fast and never redirected.
export function isPrivateAddress(address: string) {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2001:db8:");
  }
  return true;
}
export function clientMetadataUrl(clientId: string) {
  let url: URL;
  try { url = new URL(clientId); } catch { return null; }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password || url.search || clientId.length > 500) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return null;
  return url;
}
const clientMetadataSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
}).passthrough();
export function parseClientMetadata(clientId: string, document: unknown) {
  const parsed = clientMetadataSchema.safeParse(document);
  if (!parsed.success) return { error: "The client metadata document is missing client_id, client_name or redirect_uris" } as const;
  const d = parsed.data;
  if (d.client_id !== clientId) return { error: "The client metadata document's client_id does not match its URL" } as const;
  if ((d.token_endpoint_auth_method ?? "none") !== "none") return { error: "Only public clients (token_endpoint_auth_method none) are supported" } as const;
  if (d.response_types && !d.response_types.includes("code")) return { error: "The client must use the authorization code flow" } as const;
  if (!d.redirect_uris.every(validRedirectUri)) return { error: "Redirect URIs must use HTTPS or a loopback http address" } as const;
  return { client: { clientId, name: d.client_name, redirectUris: d.redirect_uris } } as const;
}
export type MetadataFetcher = (url: URL) => Promise<{ status: number; contentType: string; body: string }>;
// Production fetcher: HTTPS GET with a lookup that refuses private addresses at connect time (so DNS
// rebinding cannot slip through), no redirects, 16 KB and 5 s limits.
export const safeMetadataFetch: MetadataFetcher = (url) => new Promise((resolve, reject) => {
  const lookup = (hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) =>
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, []);
      if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return callback(Object.assign(new Error("Client metadata host resolves to a private address"), { code: "EPRIVATE" }), []);
      callback(null, (options as { all?: boolean }).all ? addresses : addresses[0].address, addresses[0].family);
    });
  const req = httpsRequest(url, { method: "GET", headers: { accept: "application/json" }, timeout: 5000, lookup: lookup as never }, (res) => {
    let size = 0; const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16_384) { req.destroy(new Error("Client metadata document is too large")); return; } chunks.push(chunk); });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("Client metadata request timed out")));
  req.on("error", reject);
  req.end();
});
export async function loadClientMetadata(clientId: string, fetcher: MetadataFetcher = safeMetadataFetch) {
  if (!egressAllowed("oauth-client-metadata")) return { error: "Client ID Metadata Documents are not fetched in offline mode; register the client instead" } as const;
  const url = clientMetadataUrl(clientId);
  if (!url) return { error: "client_id must be an HTTPS URL with a path on a public host" } as const;
  let response;
  try { response = await fetcher(url); } catch (error) { return { error: `The client metadata document could not be fetched (${error instanceof Error ? error.message.slice(0, 100) : "error"})` } as const; }
  if (response.status !== 200) return { error: `The client metadata document returned HTTP ${response.status}` } as const;
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.contentType)) return { error: "The client metadata document must be JSON" } as const;
  let json: unknown;
  try { json = JSON.parse(response.body); } catch { return { error: "The client metadata document is not valid JSON" } as const; }
  return parseClientMetadata(clientId, json);
}

// The role bounds what a token can do: admin needs a workspace admin, write needs a non-viewer.
export function scopesForRole(requested: ApiScope[], role: string) {
  return requested.filter((s) => s === "read" || (s === "write" && role !== "viewer") || (s === "admin" && ["owner", "admin"].includes(role)));
}
// OAuth error redirect (RFC 6749 4.1.2.1) with the issuer (RFC 9207).
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}
