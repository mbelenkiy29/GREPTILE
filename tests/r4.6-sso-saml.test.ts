import { generateKeyPairSync } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { eq } from "drizzle-orm";
import forge from "node-forge";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SignedXml } from "xml-crypto";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { validateSessionToken } from "@/lib/auth/sessions";
import type { Db } from "@/lib/db";
import { authAccounts, memberships, ssoSamlRequests } from "@/lib/db/schema";
import { createSsoConnection, parseSsoForm, type SsoConnectionRow } from "@/lib/sso/connections";
import { createSamlAcsHandler, createSamlMetadataHandler, createSsoStartHandler, type SsoHandlerDeps } from "@/lib/sso/handlers";
import { parseIdpMetadata } from "@/lib/sso/metadata";
import { samlAcsUrl, samlEntityId } from "@/lib/sso/saml";
import { setCookies, TEST_SECRET, testAuthConfig as config, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";

const IDP = "https://idp.acme.test/saml/metadata";
const IDP_SSO = "https://idp.acme.test/saml/sso";

interface Signer {
  cert: string;
  key: string;
}

/** A self-signed X.509 certificate generated at runtime (no key material in the repository). */
function selfSigned(cn: string): Signer {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fkey = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(fkey.n, fkey.e);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(fkey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: keyPem };
}

let idpSigner: Signer;
let otherSigner: Signer;
let db: Db;

beforeAll(() => {
  idpSigner = selfSigned("idp.acme.test");
  otherSigner = selfSigned("evil.test");
});

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function responseXml(o: { inResponseTo: string; audience: string; email: string; issuer?: string; recipient: string }): string {
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(0)}" Destination="${o.recipient}" InResponseTo="${o.inResponseTo}"><saml:Issuer>${o.issuer ?? IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_a${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${o.issuer ?? IDP}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" NotOnOrAfter="${iso(300_000)}" Recipient="${o.recipient}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Ada Lovelace</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
}

function signAssertion(xml: string, signer: Signer): string {
  const sig = new SignedXml({
    privateKey: signer.key,
    publicCert: signer.cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  return sig.getSignedXml();
}

async function setup() {
  const owner = await userWithOrg(db, { login: "owner", orgName: "Acme" });
  const input = parseSsoForm(
    form({ protocol: "saml", name: "Acme SAML", issuer: IDP, samlSsoUrl: IDP_SSO, samlCertificate: idpSigner.cert, allowedDomains: "acme.test", defaultRole: "member" }),
  );
  const connection = await createSsoConnection(db, { orgId: owner.org.id, userId: owner.user.id }, input);
  return { owner, connection };
}

const deps = (): (() => SsoHandlerDeps) => () => ({ db, config, net: { allowPrivate: false, resolve: async () => ["93.184.216.34"] } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Starts SAML sign-in and returns the AuthnRequest id from the redirect. */
async function start(connection: SsoConnectionRow): Promise<string> {
  const res = await createSsoStartHandler(deps())(new Request(`${config.appUrl}/api/auth/sso/${connection.id}/start?next=/dashboard/rules`), ctx(connection.id));
  const url = new URL(res.headers.get("location")!);
  expect(url.origin + url.pathname).toBe(IDP_SSO);
  const request = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  expect(request).toContain(`AssertionConsumerServiceURL="${samlAcsUrl(config.appUrl, connection.id)}"`);
  return /ID="([^"]+)"/.exec(request)![1]!;
}

async function post(connection: SsoConnectionRow, xml: string) {
  const res = await createSamlAcsHandler(deps())(
    new Request(samlAcsUrl(config.appUrl, connection.id), { method: "POST", body: form({ SAMLResponse: Buffer.from(xml).toString("base64") }) }),
    ctx(connection.id),
  );
  return { res, location: new URL(res.headers.get("location")!), session: setCookies(res).get(SESSION_COOKIE)?.value };
}

describe("SAML single sign-on", () => {
  test("R4.6 SAML accepts an assertion signed by the IdP certificate and provisions the member", async () => {
    const { owner, connection } = await setup();
    const id = await start(connection);
    const sp = samlEntityId(config.appUrl, connection.id);
    const { res, location, session } = await post(connection, signAssertion(responseXml({ inResponseTo: id, audience: sp, email: "Ada@acme.test", recipient: samlAcsUrl(config.appUrl, connection.id) }), idpSigner));
    expect(res.status).toBe(303);
    expect(location.pathname).toBe("/dashboard/rules");
    const active = await validateSessionToken(db, session, { now: new Date(), ttlDays: 30 });
    expect(active!.ssoOrgIds).toEqual([owner.org.id]);
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.provider, "saml"));
    expect(account).toMatchObject({ providerAccountId: `${IDP}|Ada@acme.test`, email: "ada@acme.test" });
    const [member] = await db.select().from(memberships).where(eq(memberships.userId, account!.userId));
    expect(member).toMatchObject({ orgId: owner.org.id, role: "member" });
    // The request id is single use.
    expect(await db.select().from(ssoSamlRequests)).toHaveLength(0);
  });

  test("R4.6 SAML rejects tampered, wrongly signed, unsigned, wrong-audience, foreign-issuer, and replayed responses", async () => {
    const { connection } = await setup();
    const sp = samlEntityId(config.appUrl, connection.id);
    const recipient = samlAcsUrl(config.appUrl, connection.id);
    const reject = async (name: string, build: (id: string) => string, code = "sso_invalid_response") => {
      const id = await start(connection);
      const { location, session } = await post(connection, build(id));
      expect(location.searchParams.get("error"), name).toBe(code);
      expect(session, name).toBeUndefined();
    };
    await reject("tampered", (id) => signAssertion(responseXml({ inResponseTo: id, audience: sp, email: "ada@acme.test", recipient }), idpSigner).replace("ada@acme.test</saml:NameID>", "boss@acme.test</saml:NameID>"));
    await reject("other key", (id) => signAssertion(responseXml({ inResponseTo: id, audience: sp, email: "ada@acme.test", recipient }), otherSigner));
    await reject("unsigned", (id) => responseXml({ inResponseTo: id, audience: sp, email: "ada@acme.test", recipient }));
    await reject("audience", (id) => signAssertion(responseXml({ inResponseTo: id, audience: "https://other-sp.example/metadata", email: "ada@acme.test", recipient }), idpSigner));
    await reject("issuer", (id) => signAssertion(responseXml({ inResponseTo: id, audience: sp, email: "ada@acme.test", recipient, issuer: "https://evil.test/idp" }), idpSigner));
    await reject("unknown request", () => signAssertion(responseXml({ inResponseTo: "_never_issued", audience: sp, email: "ada@acme.test", recipient }), idpSigner));
    await reject("domain", (id) => signAssertion(responseXml({ inResponseTo: id, audience: sp, email: "eve@evil.test", recipient }), idpSigner), "sso_domain_not_allowed");

    // A valid response is accepted once; replaying it is refused.
    const id = await start(connection);
    const good = signAssertion(responseXml({ inResponseTo: id, audience: sp, email: "ada@acme.test", recipient }), idpSigner);
    expect((await post(connection, good)).session).toBeDefined();
    const replay = await post(connection, good);
    expect(replay.location.searchParams.get("error")).toBe("sso_invalid_response");
    expect(await db.select().from(authAccounts).where(eq(authAccounts.provider, "saml"))).toHaveLength(1);
  });

  test("R4.6 SAML serves SP metadata and reads the IdP's metadata XML", async () => {
    const { connection } = await setup();
    const res = await createSamlMetadataHandler(deps())(new Request(samlEntityId(config.appUrl, connection.id)), ctx(connection.id));
    const xml = await res.text();
    expect(res.headers.get("content-type")).toContain("samlmetadata+xml");
    expect(xml).toContain(`entityID="${samlEntityId(config.appUrl, connection.id)}"`);
    expect(xml).toContain(`Location="${samlAcsUrl(config.appUrl, connection.id)}"`);
    expect((await createSamlMetadataHandler(deps())(new Request("https://x"), ctx("sso_unknown123456"))).status).toBe(404);

    const body = idpSigner.cert.replace(/-----[A-Z ]+-----|\s/g, "");
    const meta = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.test/post"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SSO}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
    const parsed = parseIdpMetadata(meta);
    expect(parsed.entityId).toBe(IDP);
    expect(parsed.ssoUrl).toBe(IDP_SSO);
    expect(parsed.certificates[0]!.replace(/\s/g, "")).toBe(idpSigner.cert.replace(/\s/g, ""));
    expect(() => parseIdpMetadata(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${meta}`)).toThrow(/DOCTYPE/);
    const fromForm = parseSsoForm(form({ protocol: "saml", name: "From metadata", samlMetadata: meta, allowedDomains: "acme.test", defaultRole: "admin" }));
    expect(fromForm).toMatchObject({ issuer: IDP, samlSsoUrl: IDP_SSO, defaultRole: "admin" });
  });
});
