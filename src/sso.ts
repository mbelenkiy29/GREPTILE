// Per-workspace single sign-on (SAML 2.0 and OIDC). Libraries: @node-saml/node-saml (service-provider
// side: signature, audience, timestamps, InResponseTo) and openid-client (discovery, PKCE, nonce and
// ID-token validation). An IdP-asserted email counts as verified only for a domain the workspace proved
// it owns with a DNS TXT record, so SSO can never take over an account at another domain.

import { resolveTxt } from "node:dns/promises";
import { verificationName, verificationValue } from "./sso-domains";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile as SamlProfile } from "@node-saml/node-saml";
import * as oidc from "openid-client";

export { domainSchema, emailDomain, verificationName, verificationValue, ssoEmailVerified } from "./sso-domains";

export type TxtResolver = (name: string) => Promise<string[][]>;
// True when one TXT record at _openreview-challenge.<domain> carries this workspace's token.
export async function verifyDomainTxt(domain: string, token: string, resolve: TxtResolver = resolveTxt) {
  try { return (await resolve(verificationName(domain))).some((chunks) => chunks.join("") === verificationValue(token)); }
  catch { return false; }
}

// SAML service provider for one connection. Assertions must be signed by the configured IdP key, be
// for this SP (audience), be inside their validity window, and answer a request we issued (InResponseTo,
// single use through the cache).
export type SamlConnection = { id: string; entryPoint: string; idpCert: string; idpIssuer?: string };
export const samlEntityId = (base: string, id: string) => `${base}/api/sso/saml/${id}`;
export const samlAcsUrl = (base: string, id: string) => `${base}/api/sso/saml/${id}/acs`;
export function samlServiceProvider(base: string, c: SamlConnection, cacheProvider: CacheProvider) {
  return new SAML({
    issuer: samlEntityId(base, c.id), callbackUrl: samlAcsUrl(base, c.id), entryPoint: c.entryPoint, idpCert: c.idpCert,
    ...(c.idpIssuer ? { idpIssuer: c.idpIssuer } : {}), audience: samlEntityId(base, c.id),
    wantAssertionsSigned: true, wantAuthnResponseSigned: false, acceptedClockSkewMs: 60_000,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: 10 * 60_000, cacheProvider,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", disableRequestedAuthnContext: true,
  });
}
const attribute = (p: SamlProfile, ...names: string[]) => { for (const n of names) { const v = p[n]; if (typeof v === "string" && v) return v; } return undefined; };
export function samlIdentity(p: SamlProfile) {
  const email = attribute(p, "email", "mail", "urn:oid:0.9.2342.19200300.100.1.3", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress") ?? (/^[^@\s]+@[^@\s]+$/.test(p.nameID) ? p.nameID : undefined);
  const name = attribute(p, "displayName", "name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name") ?? email ?? p.nameID;
  const xml = p.getAssertionXml?.() ?? "";
  const assertionId = /<(?:\w+:)?Assertion\b[^>]*\bID="([^"]{1,200})"/.exec(xml)?.[1];
  const notOnOrAfter = /<(?:\w+:)?Conditions\b[^>]*\bNotOnOrAfter="([^"]+)"/.exec(xml)?.[1];
  return { subject: p.nameID, email, name: name.slice(0, 100), assertionId, expiresAt: notOnOrAfter ? Date.parse(notOnOrAfter) : Date.now() + 10 * 60_000 };
}

// OIDC relying party for one connection: authorization code flow with PKCE (S256), state and nonce.
export type OidcConnection = { issuer: string; clientId: string; clientSecret: string };
// ID-token signatures are always checked against the IdP's JWKS (openid-client otherwise trusts TLS to
// the token endpoint for them, which OIDC allows but which leaves no defense if that channel is proxied).
export async function oidcConfiguration(c: OidcConnection, fetcher?: oidc.CustomFetch) {
  return oidc.discovery(new URL(c.issuer), c.clientId, c.clientSecret, undefined, { execute: [oidc.enableNonRepudiationChecks], ...(fetcher ? { [oidc.customFetch]: fetcher } : {}) });
}
export async function oidcStart(config: oidc.Configuration, redirectUri: string) {
  const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: "openid email profile", code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state, nonce });
  return { url, verifier, state, nonce };
}
export async function oidcFinish(config: oidc.Configuration, currentUrl: URL, checks: { verifier: string; state: string; nonce: string }) {
  const tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: checks.verifier, expectedState: checks.state, expectedNonce: checks.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error("The identity provider returned no subject");
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const name = typeof claims.name === "string" ? claims.name : email ?? claims.sub;
  return { subject: claims.sub, email, emailVerified: typeof claims.email_verified === "boolean" ? claims.email_verified : undefined, name: name.slice(0, 100) };
}
