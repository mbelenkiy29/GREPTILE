/**
 * Outbound HTTP for SSO (R4.6). Issuer, token, and JWKS URLs are admin-supplied, so each one passes the SSRF guard
 * (`assertPublicOrgEndpoint`: https, no credentials, every resolved address public) unless
 * SSO_ALLOW_PRIVATE_ISSUERS=true, and requests never follow redirects (a redirect could point anywhere). Requests go
 * through the outbound allowlist with the connection's own hosts added.
 */
import { assertPublicOrgEndpoint, type HostResolver } from "@/lib/llm/endpoint-guard";
import { errorMessage } from "@/lib/log";
import { createOutboundFetch } from "@/lib/net/fetch";
import { SsoError } from "./errors";

export interface SsoNetDeps {
  /** Transport (tests inject a fake IdP); defaults to the allowlist-checked fetch. */
  fetch?: typeof fetch;
  /** SSO_ALLOW_PRIVATE_ISSUERS. */
  allowPrivate: boolean;
  /** DNS for the SSRF guard (tests). */
  resolve?: HostResolver;
}

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;

/** Throws SsoError("sso_misconfigured") unless `raw` is a URL the server may call. */
export async function assertSsoUrl(raw: string, deps: SsoNetDeps, what: string): Promise<URL> {
  try {
    await assertPublicOrgEndpoint(raw, { allowPrivate: deps.allowPrivate, resolve: deps.resolve });
  } catch (err) {
    throw new SsoError(
      "sso_misconfigured",
      `${what} (${safeHost(raw)}) must be a public https URL (set SSO_ALLOW_PRIVATE_ISSUERS=true for internal identity providers): ${errorMessage(err)}`,
    );
  }
  return new URL(raw);
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "invalid URL";
  }
}

/** GET or POST to an IdP endpoint and parse JSON; no redirects, a timeout, and a response size cap. */
export async function ssoRequest(url: URL, init: RequestInit, deps: SsoNetDeps, what: string): Promise<{ status: number; body: unknown }> {
  const doFetch = deps.fetch ?? createOutboundFetch({ allow: [url.host] });
  let res: Response;
  try {
    res = await doFetch(url.toString(), { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new SsoError("sso_unavailable", `${what} at ${url.host} is unreachable: ${errorMessage(err)}`, { cause: err });
  }
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new SsoError("sso_invalid_response", `${what} returned an oversized response`);
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
