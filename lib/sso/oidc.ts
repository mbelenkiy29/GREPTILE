/**
 * OpenID Connect sign-in (R4.6): discovery, the authorization request (state + nonce + PKCE S256), the code exchange,
 * and ID token verification with `jose` (signature against the issuer's JWKS, `iss`, `aud`, `azp`, `exp`/`iat` with
 * a small clock skew, and the nonce). Discovery documents and key sets are cached per issuer; an unknown `kid`
 * refreshes the key set once (key rotation).
 */
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import { safeEqual } from "@/lib/crypto";
import { errorMessage } from "@/lib/log";
import { SsoError } from "./errors";
import { assertSsoUrl, ssoRequest, type SsoNetDeps } from "./net";

export const DISCOVERY_TTL_MS = 60 * 60 * 1000;
export const CLOCK_SKEW_S = 120;
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

export type OidcDiscovery = z.infer<typeof discoverySchema>;

interface CacheEntry {
  discovery: OidcDiscovery;
  jwks: JSONWebKeySet | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Forgets cached discovery and keys (after a connection changes, and in tests). */
export function clearOidcCache(issuer?: string): void {
  if (issuer) cache.delete(issuer);
  else cache.clear();
}

/** Fetches (or reuses) the issuer's discovery document; every endpoint in it must pass the SSRF guard. */
export async function discover(issuer: string, deps: SsoNetDeps & { now?: number }): Promise<OidcDiscovery> {
  const now = deps.now ?? Date.now();
  const hit = cache.get(issuer);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.discovery;
  const url = await assertSsoUrl(`${issuer}/.well-known/openid-configuration`, deps, "The OIDC discovery URL");
  const res = await ssoRequest(url, { headers: { accept: "application/json" } }, deps, "OIDC discovery");
  if (res.status !== 200) throw new SsoError("sso_unavailable", `OIDC discovery returned ${res.status}`);
  const parsed = discoverySchema.safeParse(res.body);
  if (!parsed.success) throw new SsoError("sso_misconfigured", "the OIDC discovery document is missing required endpoints");
  // OpenID Connect Discovery §4.3: the document's issuer must be exactly the issuer it was fetched for.
  if (parsed.data.issuer.replace(/\/+$/, "") !== issuer) {
    throw new SsoError("sso_misconfigured", `the discovery document names issuer ${parsed.data.issuer}, not ${issuer}`);
  }
  await assertSsoUrl(parsed.data.token_endpoint, deps, "The OIDC token endpoint");
  await assertSsoUrl(parsed.data.jwks_uri, deps, "The OIDC JWKS URL");
  const authorize = new URL(parsed.data.authorization_endpoint);
  if (authorize.protocol !== "https:" && !(deps.allowPrivate && authorize.protocol === "http:")) {
    throw new SsoError("sso_misconfigured", "the OIDC authorization endpoint must use https");
  }
  cache.set(issuer, { discovery: parsed.data, jwks: null, at: now });
  return parsed.data;
}

const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).max(100) });

async function fetchJwks(issuer: string, discovery: OidcDiscovery, deps: SsoNetDeps, force: boolean): Promise<JSONWebKeySet> {
  const entry = cache.get(issuer);
  if (entry?.jwks && !force) return entry.jwks;
  const url = await assertSsoUrl(discovery.jwks_uri, deps, "The OIDC JWKS URL");
  const res = await ssoRequest(url, { headers: { accept: "application/json" } }, deps, "OIDC JWKS");
  const parsed = jwksSchema.safeParse(res.body);
  if (res.status !== 200 || !parsed.success) throw new SsoError("sso_unavailable", `the OIDC JWKS endpoint returned ${res.status}`);
  const jwks = parsed.data as unknown as JSONWebKeySet;
  if (entry) entry.jwks = jwks;
  return jwks;
}

/** The authorization URL the browser is sent to. */
export function authorizationUrl(
  discovery: OidcDiscovery,
  input: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

const tokenSchema = z.object({ id_token: z.string().min(1).max(20_000), token_type: z.string().optional() });

/** Exchanges the authorization code (+ PKCE verifier) for tokens; returns the raw ID token. */
export async function exchangeCode(
  discovery: OidcDiscovery,
  input: { code: string; codeVerifier: string; redirectUri: string; clientId: string; clientSecret: string },
  deps: SsoNetDeps,
): Promise<string> {
  const url = await assertSsoUrl(discovery.token_endpoint, deps, "The OIDC token endpoint");
  const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier });
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  // client_secret_basic is the default (RFC 6749 §2.3.1); use client_secret_post only when that is all the IdP offers.
  const methods = discovery.token_endpoint_auth_methods_supported;
  if (methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
    form.set("client_id", input.clientId);
    form.set("client_secret", input.clientSecret);
  } else {
    const basic = Buffer.from(`${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }
  const res = await ssoRequest(url, { method: "POST", headers, body: form.toString() }, deps, "OIDC token endpoint");
  if (res.status >= 500) throw new SsoError("sso_unavailable", `the OIDC token endpoint returned ${res.status}`);
  const parsed = tokenSchema.safeParse(res.body);
  if (res.status !== 200 || !parsed.success) {
    const reason = res.body && typeof res.body === "object" && "error" in res.body ? String((res.body as { error: unknown }).error).slice(0, 100) : `status ${res.status}`;
    throw new SsoError("sso_idp_error", `the identity provider refused the authorization code: ${reason}`);
  }
  return parsed.data.id_token;
}

export interface OidcIdentity {
  /** `iss|sub`: stable across email changes. */
  subject: string;
  email: string;
  name: string;
}

function emailVerified(payload: JWTPayload): boolean {
  const v = payload.email_verified;
  return v === true || v === "true";
}

/**
 * Verifies an ID token and returns the identity. Rejects a bad signature, wrong issuer or audience, a token issued
 * for another client (`azp`), an expired or not-yet-valid token, a nonce mismatch, and a missing or unverified email.
 */
export async function verifyIdToken(
  idToken: string,
  input: { issuer: string; discovery: OidcDiscovery; clientId: string; nonce: string; now: Date },
  deps: SsoNetDeps,
): Promise<OidcIdentity> {
  const verify = async (force: boolean) => {
    const jwks = await fetchJwks(input.issuer, input.discovery, deps, force);
    return jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: input.discovery.issuer,
      audience: input.clientId,
      algorithms: ALGORITHMS,
      clockTolerance: CLOCK_SKEW_S,
      currentDate: input.now,
      requiredClaims: ["sub", "exp", "iat", "nonce"],
    });
  };
  let payload: JWTPayload;
  try {
    try {
      ({ payload } = await verify(false));
    } catch (err) {
      if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw err;
      ({ payload } = await verify(true));
    }
  } catch (err) {
    if (err instanceof SsoError) throw err;
    throw new SsoError("sso_invalid_response", `the ID token was rejected: ${errorMessage(err)}`, { cause: err });
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud.length > 1 && payload.azp !== input.clientId) throw new SsoError("sso_invalid_response", "the ID token was issued to another client (azp)");
  if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, input.nonce)) throw new SsoError("sso_invalid_response", "the ID token nonce does not match");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) throw new SsoError("sso_email_unverified", "the ID token has no email claim");
  if (!emailVerified(payload)) throw new SsoError("sso_email_unverified", "the identity provider did not mark the email as verified");
  const given = [payload.given_name, payload.family_name].filter((v): v is string => typeof v === "string" && v.length > 0).join(" ");
  const name = (typeof payload.name === "string" && payload.name.trim()) || given || email.slice(0, email.indexOf("@"));
  return { subject: `${input.discovery.issuer}|${payload.sub}`, email, name: name.slice(0, 255) };
}
