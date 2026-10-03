/**
 * SSO connections (R4.6): an org's OIDC or SAML identity provider, managed by its owners. Client secrets are encrypted
 * at rest (lib/crypto) and never returned to the UI; every change is audited.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { encryptSecret, randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { auditUserAction, type UserActor } from "@/lib/data/audit";
import { scoped } from "@/lib/data/tenant";
import { orgs, ssoConnections } from "@/lib/db/schema";
import { MetadataError, parseIdpMetadata } from "./metadata";

export type SsoConnectionRow = typeof ssoConnections.$inferSelect;
export type SsoProtocol = SsoConnectionRow["protocol"];

/** What the settings UI may see: never the encrypted secret. */
export type SsoConnectionView = Omit<SsoConnectionRow, "clientSecretEnc"> & { hasClientSecret: boolean };

export class SsoConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SsoConfigError";
  }
}

export function newConnectionId(): string {
  return `sso_${randomToken(12)}`;
}

export function toView(row: SsoConnectionRow): SsoConnectionView {
  const { clientSecretEnc, ...rest } = row;
  return { ...rest, hasClientSecret: Boolean(clientSecretEnc) };
}

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Parses "example.com, Example.org\nfoo.io" into unique lowercase domains; throws on an invalid one. */
export function parseDomains(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const d = part.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
    if (!d) continue;
    if (!DOMAIN.test(d)) throw new SsoConfigError(`"${part.trim().slice(0, 80)}" is not a valid domain.`, "allowedDomains");
    out.add(d);
  }
  if (out.size === 0) throw new SsoConfigError("Add at least one email domain that may sign in.", "allowedDomains");
  if (out.size > 50) throw new SsoConfigError("At most 50 domains per connection.", "allowedDomains");
  return [...out];
}

/** Normalizes an issuer or discovery URL to the issuer (no trailing slash, no `/.well-known/openid-configuration`). */
export function normalizeIssuer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsoConfigError("Enter the issuer URL, e.g. https://login.example.com/realms/acme.", "issuer");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SsoConfigError("The issuer must be an https URL.", "issuer");
  if (url.username || url.password || url.search || url.hash) throw new SsoConfigError("The issuer URL must not contain credentials, a query, or a fragment.", "issuer");
  const path = url.pathname.replace(/\/\.well-known\/openid-configuration$/, "").replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

const PEM_BODY = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g;

/** Splits pasted certificates (PEM blocks, or one bare base64 body) into normalized PEM strings. */
export function parseCertificates(raw: string): string[] {
  const bodies: string[] = [];
  for (const m of raw.matchAll(PEM_BODY)) bodies.push(m[1]!);
  if (bodies.length === 0 && raw.trim()) bodies.push(raw);
  return bodies.map((b) => {
    const clean = b.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+=*$/.test(clean) || clean.length < 100) throw new SsoConfigError("The IdP certificate is not a valid X.509 certificate (PEM).", "samlCertificate");
    return `-----BEGIN CERTIFICATE-----\n${clean.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
  });
}

const textField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || undefined)
    .optional();

const formSchema = z.object({
  protocol: z.enum(["oidc", "saml"]),
  name: z.string().trim().min(1, "Give the connection a name.").max(80, "Names are at most 80 characters."),
  issuer: textField(2048),
  clientId: textField(512),
  clientSecret: textField(4096),
  samlMetadata: textField(500_000),
  samlSsoUrl: textField(2048),
  samlCertificate: textField(50_000),
  allowedDomains: z.string().max(10_000),
  defaultRole: z.enum(["member", "admin"]),
});

/** Validated connection settings (the secret still in plaintext; it is encrypted when stored). */
export interface SsoConnectionInput {
  protocol: SsoProtocol;
  name: string;
  issuer: string;
  clientId: string | null;
  /** New client secret; undefined keeps the stored one. */
  clientSecret?: string;
  samlSsoUrl: string | null;
  samlCertificates: string[];
  allowedDomains: string[];
  defaultRole: "member" | "admin";
}

function httpsUrl(raw: string | undefined, field: string, label: string): string {
  if (!raw) throw new SsoConfigError(`${label} is required.`, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsoConfigError(`${label} must be a URL.`, field);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SsoConfigError(`${label} must be an https URL.`, field);
  return url.toString();
}

/**
 * Parses the settings form. `existing` is the connection being edited (its secret is kept when the field is blank).
 * SAML settings come from pasted IdP metadata XML when given, else from the entity id + SSO URL + certificate fields.
 */
export function parseSsoForm(form: FormData, existing?: SsoConnectionRow): SsoConnectionInput {
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const parsed = formSchema.safeParse({
    protocol: existing?.protocol ?? str("protocol"),
    name: str("name"),
    issuer: str("issuer"),
    clientId: str("clientId"),
    clientSecret: str("clientSecret"),
    samlMetadata: str("samlMetadata"),
    samlSsoUrl: str("samlSsoUrl"),
    samlCertificate: str("samlCertificate"),
    allowedDomains: str("allowedDomains"),
    defaultRole: str("defaultRole") || "member",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SsoConfigError(issue?.message ?? "Check the form and try again.", issue?.path[0]?.toString());
  }
  const f = parsed.data;
  const allowedDomains = parseDomains(f.allowedDomains);
  const common = { protocol: f.protocol, name: f.name, allowedDomains, defaultRole: f.defaultRole };

  if (f.protocol === "oidc") {
    if (!f.issuer) throw new SsoConfigError("The issuer URL is required.", "issuer");
    if (!f.clientId) throw new SsoConfigError("The client ID is required.", "clientId");
    if (!f.clientSecret && !existing?.clientSecretEnc) throw new SsoConfigError("The client secret is required.", "clientSecret");
    return {
      ...common,
      issuer: normalizeIssuer(f.issuer),
      clientId: f.clientId,
      ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}),
      samlSsoUrl: null,
      samlCertificates: [],
    };
  }

  if (f.samlMetadata) {
    let meta;
    try {
      meta = parseIdpMetadata(f.samlMetadata);
    } catch (err) {
      if (err instanceof MetadataError) throw new SsoConfigError(err.message, "samlMetadata");
      throw err;
    }
    return { ...common, issuer: meta.entityId, clientId: null, samlSsoUrl: httpsUrl(meta.ssoUrl, "samlMetadata", "The metadata's SSO URL"), samlCertificates: meta.certificates };
  }
  if (!f.issuer) throw new SsoConfigError("The IdP entity ID is required (or paste the IdP metadata XML).", "issuer");
  const certs = f.samlCertificate ? parseCertificates(f.samlCertificate) : (existing?.samlCertificates ?? []);
  if (!certs.length) throw new SsoConfigError("The IdP signing certificate is required.", "samlCertificate");
  return {
    ...common,
    issuer: f.issuer,
    clientId: null,
    samlSsoUrl: httpsUrl(f.samlSsoUrl ?? existing?.samlSsoUrl ?? undefined, "samlSsoUrl", "The IdP SSO URL"),
    samlCertificates: certs,
  };
}

export async function listSsoConnections(db: Db, orgId: string): Promise<SsoConnectionView[]> {
  const rows = await db.select().from(ssoConnections).where(scoped(ssoConnections, orgId)).orderBy(asc(ssoConnections.createdAt));
  return rows.map(toView);
}

export async function getSsoConnection(db: Db, orgId: string, id: string): Promise<SsoConnectionRow | undefined> {
  const [row] = await db.select().from(ssoConnections).where(scoped(ssoConnections, orgId, eq(ssoConnections.id, id)));
  return row;
}

/**
 * Looks up a connection by id for the public sign-in routes, which have no org yet: the connection id (random,
 * unguessable) is the only input, and the row's own org id scopes everything that follows.
 */
export async function findSsoConnectionById(db: Db, id: string): Promise<SsoConnectionRow | undefined> {
  if (!/^sso_[\w-]{8,40}$/.test(id)) return undefined;
  const [row] = await db.select().from(ssoConnections).where(eq(ssoConnections.id, id));
  return row;
}

/** What an audit entry records about a connection change (never the secret). */
function auditMetadata(input: SsoConnectionInput) {
  return {
    protocol: input.protocol,
    name: input.name,
    issuer: input.issuer,
    allowedDomains: input.allowedDomains,
    defaultRole: input.defaultRole,
    clientSecretChanged: input.clientSecret !== undefined,
  };
}

export async function createSsoConnection(db: Db, actor: UserActor, input: SsoConnectionInput): Promise<SsoConnectionRow> {
  const [row] = await db
    .insert(ssoConnections)
    .values({
      id: newConnectionId(),
      orgId: actor.orgId,
      protocol: input.protocol,
      name: input.name,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretEnc: input.clientSecret ? encryptSecret(input.clientSecret) : null,
      samlSsoUrl: input.samlSsoUrl,
      samlCertificates: input.samlCertificates,
      allowedDomains: input.allowedDomains,
      defaultRole: input.defaultRole,
      // A new connection never enforces SSO before someone has signed in through it (see setSsoEnforcement).
      enforce: false,
      enabled: true,
      createdBy: actor.userId,
    })
    .returning();
  await auditUserAction(db, actor, { action: "sso.connection_created", targetType: "sso_connection", targetId: row!.id, metadata: auditMetadata(input) });
  return row!;
}

export async function updateSsoConnection(db: Db, actor: UserActor, id: string, input: SsoConnectionInput): Promise<SsoConnectionRow | undefined> {
  const [row] = await db
    .update(ssoConnections)
    .set({
      name: input.name,
      issuer: input.issuer,
      clientId: input.clientId,
      ...(input.clientSecret !== undefined ? { clientSecretEnc: encryptSecret(input.clientSecret) } : {}),
      samlSsoUrl: input.samlSsoUrl,
      samlCertificates: input.samlCertificates,
      allowedDomains: input.allowedDomains,
      defaultRole: input.defaultRole,
      updatedAt: actor.now ?? new Date(),
    })
    .where(scoped(ssoConnections, actor.orgId, eq(ssoConnections.id, id)))
    .returning();
  if (row) await auditUserAction(db, actor, { action: "sso.connection_updated", targetType: "sso_connection", targetId: id, metadata: auditMetadata(input) });
  return row;
}

export async function setSsoConnectionEnabled(db: Db, actor: UserActor, id: string, enabled: boolean): Promise<SsoConnectionRow | undefined> {
  const [row] = await db
    .update(ssoConnections)
    // Disabling a connection also stops enforcing it, so members are never locked out by a connection nobody can use.
    .set({ enabled, ...(enabled ? {} : { enforce: false }), updatedAt: actor.now ?? new Date() })
    .where(scoped(ssoConnections, actor.orgId, eq(ssoConnections.id, id)))
    .returning();
  if (row) await auditUserAction(db, actor, { action: enabled ? "sso.connection_enabled" : "sso.connection_disabled", targetType: "sso_connection", targetId: id });
  return row;
}

/**
 * Turns enforcement on or off. Turning it on requires that the acting owner's own session signed in through SSO to
 * this org (`actorHasSso`), proving the connection works before everyone else is required to use it.
 */
export async function setSsoEnforcement(
  db: Db,
  actor: UserActor & { actorHasSso: boolean },
  id: string,
  enforce: boolean,
): Promise<SsoConnectionRow | undefined> {
  const existing = await getSsoConnection(db, actor.orgId, id);
  if (!existing) return undefined;
  if (enforce && !existing.enabled) throw new SsoConfigError("Enable the connection before enforcing it.", "enforce");
  if (enforce && !actor.actorHasSso) {
    throw new SsoConfigError("Sign in through this connection yourself before requiring it, so you can't lock everyone out.", "enforce");
  }
  const [row] = await db
    .update(ssoConnections)
    .set({ enforce, updatedAt: actor.now ?? new Date() })
    .where(scoped(ssoConnections, actor.orgId, eq(ssoConnections.id, id)))
    .returning();
  await auditUserAction(db, actor, { action: enforce ? "sso.enforcement_enabled" : "sso.enforcement_disabled", targetType: "sso_connection", targetId: id });
  return row;
}

export async function deleteSsoConnection(db: Db, actor: UserActor, id: string): Promise<boolean> {
  const rows = await db.delete(ssoConnections).where(scoped(ssoConnections, actor.orgId, eq(ssoConnections.id, id))).returning({ id: ssoConnections.id, name: ssoConnections.name });
  if (rows.length) await auditUserAction(db, actor, { action: "sso.connection_deleted", targetType: "sso_connection", targetId: id, metadata: { name: rows[0]!.name } });
  return rows.length > 0;
}

export type SsoLookup = { status: "found"; connection: SsoConnectionRow } | { status: "not_found" } | { status: "ambiguous" };

/**
 * The enabled connection for what someone typed on the sign-in page: an email (matched by its domain against the
 * connections' allowed domains) or an org slug. Several orgs claiming the same domain is ambiguous: the person must
 * use their org's slug instead.
 */
export async function lookupSsoConnection(db: Db, identifier: string): Promise<SsoLookup> {
  const value = identifier.trim().toLowerCase();
  if (!value || value.length > 320) return { status: "not_found" };
  if (value.includes("@")) {
    const domain = value.slice(value.lastIndexOf("@") + 1);
    if (!DOMAIN.test(domain)) return { status: "not_found" };
    const rows = await db
      .select()
      .from(ssoConnections)
      .where(and(eq(ssoConnections.enabled, true), sql`${domain} = ANY(${ssoConnections.allowedDomains})`))
      .orderBy(asc(ssoConnections.createdAt))
      .limit(5);
    const orgIds = new Set(rows.map((r) => r.orgId));
    if (orgIds.size > 1) return { status: "ambiguous" };
    return rows[0] ? { status: "found", connection: rows[0] } : { status: "not_found" };
  }
  const [row] = await db
    .select({ connection: ssoConnections })
    .from(ssoConnections)
    .innerJoin(orgs, eq(orgs.id, ssoConnections.orgId))
    .where(and(eq(orgs.slug, value), eq(ssoConnections.enabled, true)))
    .orderBy(asc(ssoConnections.createdAt))
    .limit(1);
  return row ? { status: "found", connection: row.connection } : { status: "not_found" };
}

/** Whether an email's domain is one of the connection's allowed domains (exact match, case-insensitive). */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.some((d) => d.toLowerCase() === domain);
}
