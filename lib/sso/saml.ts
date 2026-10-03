/**
 * SAML 2.0 sign-in (R4.6) with `@node-saml/node-saml`. OpenReview is the service provider: its entity id is
 * `APP_URL/api/auth/saml/<id>/metadata` and its assertion consumer service is `.../acs`. Responses must carry an
 * assertion signed by one of the connection's IdP certificates, be addressed to our entity id (audience), come from
 * the configured IdP entity id, be within their validity window (two minutes of clock skew), and answer a request we
 * issued (`InResponseTo`, single use, kept in Postgres so any web process can check it). IdP-initiated sign-in is
 * therefore not accepted.
 */
import { and, eq, gt, lt } from "drizzle-orm";
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import type { Db } from "@/lib/db";
import { ssoSamlRequests } from "@/lib/db/schema";
import { errorMessage } from "@/lib/log";
import type { SsoConnectionRow } from "./connections";
import { SsoError } from "./errors";

export const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;
export const SAML_CLOCK_SKEW_MS = 2 * 60 * 1000;
/** Largest SAMLResponse form field accepted (base64). */
export const MAX_SAML_RESPONSE_BYTES = 512 * 1024;

const EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "emailAddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
];
const NAME_ATTRIBUTES = ["displayName", "name", "cn", "urn:oid:2.16.840.1.113730.3.1.241", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];

export function samlEntityId(appUrl: string, connectionId: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/auth/saml/${connectionId}/metadata`;
}

export function samlAcsUrl(appUrl: string, connectionId: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/auth/saml/${connectionId}/acs`;
}

interface PendingRequest {
  next: string;
  linkUserId: string | null;
}

/**
 * node-saml's request-id cache backed by `sso_saml_requests`. One instance serves one start or one ACS request:
 * `context` is stored with a new request id, and `found` remembers what a validated id carried.
 */
class PostgresSamlCache implements CacheProvider {
  found: PendingRequest | null = null;

  constructor(
    private readonly db: Db,
    private readonly connection: Pick<SsoConnectionRow, "id" | "orgId">,
    private readonly now: () => Date,
    private readonly context: PendingRequest = { next: "/dashboard", linkUserId: null },
  ) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const now = this.now();
    await this.db.delete(ssoSamlRequests).where(lt(ssoSamlRequests.expiresAt, now));
    await this.db.insert(ssoSamlRequests).values({
      id: key,
      orgId: this.connection.orgId,
      connectionId: this.connection.id,
      next: this.context.next,
      linkUserId: this.context.linkUserId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SAML_REQUEST_TTL_MS),
    });
    return { value, createdAt: now.getTime() };
  }

  async getAsync(key: string): Promise<string | null> {
    if (!key || key.length > 256) return null;
    const [row] = await this.db
      .select()
      .from(ssoSamlRequests)
      .where(and(eq(ssoSamlRequests.id, key), eq(ssoSamlRequests.connectionId, this.connection.id), gt(ssoSamlRequests.expiresAt, this.now())));
    if (!row) return null;
    this.found = { next: row.next, linkUserId: row.linkUserId };
    return row.createdAt.toISOString();
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const rows = await this.db.delete(ssoSamlRequests).where(and(eq(ssoSamlRequests.id, key), eq(ssoSamlRequests.connectionId, this.connection.id))).returning({ id: ssoSamlRequests.id });
    return rows[0]?.id ?? null;
  }
}

function client(connection: SsoConnectionRow, appUrl: string, cache: CacheProvider): SAML {
  if (connection.protocol !== "saml" || !connection.samlSsoUrl || connection.samlCertificates.length === 0) {
    throw new SsoError("sso_misconfigured", "the SAML connection is missing its SSO URL or certificate");
  }
  const entityId = samlEntityId(appUrl, connection.id);
  return new SAML({
    entryPoint: connection.samlSsoUrl,
    issuer: entityId,
    audience: entityId,
    callbackUrl: samlAcsUrl(appUrl, connection.id),
    idpIssuer: connection.issuer,
    idpCert: connection.samlCertificates,
    // The assertion itself must be signed; a signed response wrapping an unsigned assertion is not enough.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider: cache,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    disableRequestedAuthnContext: true,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
  });
}

/** The IdP URL to send the browser to (HTTP-Redirect binding), after recording the request id. */
export async function samlAuthorizeUrl(
  db: Db,
  connection: SsoConnectionRow,
  input: { appUrl: string; next: string; linkUserId: string | null; now?: () => Date },
): Promise<string> {
  const cache = new PostgresSamlCache(db, connection, input.now ?? (() => new Date()), { next: input.next, linkUserId: input.linkUserId });
  try {
    return await client(connection, input.appUrl, cache).getAuthorizeUrlAsync("", undefined, {});
  } catch (err) {
    if (err instanceof SsoError) throw err;
    throw new SsoError("sso_misconfigured", `could not build the SAML request: ${errorMessage(err)}`, { cause: err });
  }
}

export interface SamlIdentity {
  /** `idpEntityId|NameID`. */
  subject: string;
  email: string;
  name: string;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.map(firstString).find((v): v is string => !!v);
  return undefined;
}

/** The email (NameID when it is an email, else a mail attribute) and display name of a validated profile. */
export function samlProfileIdentity(profile: Profile, idpEntityId: string): SamlIdentity {
  const nameId = profile.nameID?.trim();
  if (!nameId) throw new SsoError("sso_invalid_response", "the SAML assertion has no NameID");
  const fromAttributes = EMAIL_ATTRIBUTES.map((a) => firstString(profile[a])).find((v): v is string => !!v);
  const candidate = (/^[^@\s]+@[^@\s]+$/.test(nameId) ? nameId : fromAttributes)?.toLowerCase();
  if (!candidate || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) throw new SsoError("sso_email_unverified", "the SAML assertion carries no email address");
  const name = NAME_ATTRIBUTES.map((a) => firstString(profile[a])).find((v): v is string => !!v) ?? candidate.slice(0, candidate.indexOf("@"));
  return { subject: `${idpEntityId}|${nameId}`, email: candidate, name: name.slice(0, 255) };
}

/** Validates a posted SAMLResponse and returns the identity plus the pending request it answers. */
export async function validateSamlResponse(
  db: Db,
  connection: SsoConnectionRow,
  input: { appUrl: string; samlResponse: string; now?: () => Date },
): Promise<SamlIdentity & PendingRequest> {
  if (!input.samlResponse || input.samlResponse.length > MAX_SAML_RESPONSE_BYTES) throw new SsoError("sso_invalid_response", "missing or oversized SAMLResponse");
  const cache = new PostgresSamlCache(db, connection, input.now ?? (() => new Date()));
  let profile: Profile | null;
  try {
    ({ profile } = await client(connection, input.appUrl, cache).validatePostResponseAsync({ SAMLResponse: input.samlResponse }));
  } catch (err) {
    if (err instanceof SsoError) throw err;
    throw new SsoError("sso_invalid_response", `the SAML response was rejected: ${errorMessage(err)}`, { cause: err });
  }
  if (!profile || !cache.found) throw new SsoError("sso_invalid_response", "the SAML response did not answer a pending sign-in request");
  // Single use, even if the library kept the id (e.g. a response without a SubjectConfirmation InResponseTo).
  if (typeof profile.inResponseTo === "string") await cache.removeAsync(profile.inResponseTo);
  return { ...samlProfileIdentity(profile, connection.issuer), ...cache.found };
}

/** The service provider metadata XML for a connection (to paste into the IdP). */
export function samlServiceProviderMetadata(connection: SsoConnectionRow, appUrl: string): string {
  const entityId = samlEntityId(appUrl, connection.id);
  const acs = samlAcsUrl(appUrl, connection.id);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${esc(entityId)}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(acs)}" index="1" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>
`;
}
