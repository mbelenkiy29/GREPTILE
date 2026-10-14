import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import * as oidc from "openid-client";
import { oidcConfiguration, oidcFinish, oidcStart, samlIdentity, samlServiceProvider, ssoEmailVerified, verificationName, verificationValue, verifyDomainTxt } from "../src/sso";

const base = "https://review.example.com", connection = "conn1";
const sp = `${base}/api/sso/saml/${connection}`, acs = `${sp}/acs`, idp = "https://idp.example.com/saml";
const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() }; };
const idpKey = pair(), otherKey = pair();
// In-memory stand-in for the Convex-backed request cache.
const cache = () => { const m = new Map<string, string>(); return { m, provider: { saveAsync: async (k: string, v: string) => { m.set(k, v); return { value: v, createdAt: Date.now() }; }, getAsync: async (k: string) => m.get(k) ?? null, removeAsync: async (k: string | null) => { const v = k ? m.get(k) ?? null : null; if (k) m.delete(k); return v; } } }; };
const iso = (ms: number) => new Date(ms).toISOString();
function response(requestId: string, o: { audience?: string; notOnOrAfter?: number; email?: string; assertionId?: string } = {}) {
  const now = Date.now(), until = iso(o.notOnOrAfter ?? now + 5 * 60_000), email = o.email ?? "dev@acme.com";
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${acs}" InResponseTo="${requestId}"><saml:Issuer>${idp}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${o.assertionId ?? "_a" + randomUUID()}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${idp}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" NotOnOrAfter="${until}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? sp}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Dev One</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
}
function sign(xml: string, privatePem = idpKey.privatePem) {
  const sig = new SignedXml({ privateKey: privatePem, canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#", signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  return sig.getSignedXml();
}
const post = (xml: string) => ({ SAMLResponse: Buffer.from(xml).toString("base64") });
async function issueRequest(service: ReturnType<typeof samlServiceProvider>) {
  const url = new URL(await service.getAuthorizeUrlAsync("relay", undefined, {}));
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString();
  return { url, id: /\bID="([^"]+)"/.exec(xml)![1] };
}

test("SAML: a signed assertion for this service provider, answering our request, signs the user in once", async () => {
  const c = cache(), service = samlServiceProvider(base, { id: connection, entryPoint: "https://idp.example.com/sso", idpCert: idpKey.publicPem, idpIssuer: idp }, c.provider);
  const { url, id } = await issueRequest(service);
  assert.equal(url.origin + url.pathname, "https://idp.example.com/sso");
  assert.ok(c.m.has(id), "the request id is remembered for InResponseTo");
  const signed = sign(response(id, { assertionId: "_assertion-1" }));
  const { profile } = await service.validatePostResponseAsync(post(signed));
  const identity = samlIdentity(profile!);
  assert.deepEqual([identity.subject, identity.email, identity.name, identity.assertionId], ["dev@acme.com", "dev@acme.com", "Dev One", "_assertion-1"]);
  assert.ok(identity.expiresAt > Date.now());
  assert.equal(c.m.has(id), false, "the request id is single use");
  // Replay: the same response is refused because its request was already answered.
  await assert.rejects(service.validatePostResponseAsync(post(signed)), /InResponseTo is not valid/);
});

test("SAML: expired, wrong-audience, unsigned, tampered, wrong-key and unsolicited responses are refused", async () => {
  const c = cache(), service = samlServiceProvider(base, { id: connection, entryPoint: "https://idp.example.com/sso", idpCert: idpKey.publicPem, idpIssuer: idp }, c.provider);
  const attempt = async (make: (id: string) => string) => { const { id } = await issueRequest(service); return service.validatePostResponseAsync(post(make(id))); };
  await assert.rejects(attempt((id) => sign(response(id, { notOnOrAfter: Date.now() - 5 * 60_000 }))), /expired|NotOnOrAfter|No valid subject confirmation/i);
  await assert.rejects(attempt((id) => sign(response(id, { audience: "https://other.example.com/sp" }))), /audience/i);
  await assert.rejects(attempt((id) => response(id)), /signature/i);
  await assert.rejects(attempt((id) => sign(response(id)).replace(">dev@acme.com<", ">ceo@acme.com<")), /signature|invalid/i);
  await assert.rejects(attempt((id) => sign(response(id), otherKey.privatePem)), /signature/i);
  await assert.rejects(service.validatePostResponseAsync(post(sign(response("_never-issued")))), /InResponseTo/);
});

test("domain verification reads one TXT record; SSO emails are verified only on verified domains", async () => {
  assert.equal(verificationName("acme.com"), "_openreview-challenge.acme.com");
  const records: Record<string, string[][]> = { "_openreview-challenge.acme.com": [["unrelated"], ["openreview-domain-verification=", "tok123"]] };
  const resolve = async (name: string) => { if (!records[name]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return records[name]; };
  assert.equal(await verifyDomainTxt("acme.com", "tok123", resolve), true, "split TXT chunks are joined");
  assert.equal(verificationValue("tok123"), "openreview-domain-verification=tok123");
  assert.equal(await verifyDomainTxt("acme.com", "other", resolve), false);
  assert.equal(await verifyDomainTxt("missing.com", "tok123", resolve), false);
  assert.equal(ssoEmailVerified("dev@acme.com", ["acme.com"]), true);
  assert.equal(ssoEmailVerified("Dev@ACME.com", ["acme.com"]), true);
  assert.equal(ssoEmailVerified("dev@evil.com", ["acme.com"]), false, "an IdP cannot vouch for another domain");
  assert.equal(ssoEmailVerified("dev@acme.com", ["acme.com"], false), false, "an OIDC email_verified=false wins");
  assert.equal(ssoEmailVerified(undefined, ["acme.com"]), false);
});

test("OIDC: discovery, PKCE + state + nonce, and ID-token checks against the IdP's keys", async () => {
  const issuer = "https://login.example.com", clientId = "openreview", { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let idToken = "";
  const fetcher: oidc.CustomFetch = async (url, options) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
    if (u === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (u === `${issuer}/token`) { assert.match(String(options.body), /code_verifier=/); return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken }); }
    return new Response("not found", { status: 404 });
  };
  const config = await oidcConfiguration({ issuer, clientId, clientSecret: "secret" }, fetcher);
  const start = await oidcStart(config, `${base}/api/sso/oidc/callback`);
  assert.deepEqual([start.url.origin + start.url.pathname, start.url.searchParams.get("code_challenge_method"), start.url.searchParams.get("state"), start.url.searchParams.get("nonce")], [`${issuer}/authorize`, "S256", start.state, start.nonce]);
  const token = ({ aud = clientId, ...claims }: Record<string, unknown>, key = privateKey) => new SignJWT({ email: "dev@acme.com", email_verified: true, name: "Dev One", nonce: start.nonce, ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(aud as string).setSubject("user-42").setIssuedAt().setExpirationTime("5m").sign(key);
  const callback = (state = start.state) => new URL(`${base}/api/sso/oidc/callback?code=abc&state=${state}`);
  idToken = await token({});
  assert.deepEqual(await oidcFinish(config, callback(), start), { subject: "user-42", email: "dev@acme.com", emailVerified: true, name: "Dev One" });
  // openid-client reports the specific failed check in the error's cause.
  const refused = (pattern: RegExp) => (e: Error & { cause?: Error }) => pattern.test(`${e.message} ${e.cause?.message ?? ""}`);
  idToken = await token({ nonce: "other" });
  await assert.rejects(oidcFinish(config, callback(), start), refused(/"nonce"/));
  idToken = await token({ aud: "someone-else" });
  await assert.rejects(oidcFinish(config, callback(), start), refused(/"aud"/));
  idToken = await token({}, (await generateKeyPair("RS256")).privateKey);
  await assert.rejects(oidcFinish(config, callback(), start), refused(/signature/i));
  idToken = await token({});
  await assert.rejects(oidcFinish(config, callback("forged-state"), start), refused(/"state"/));
});
