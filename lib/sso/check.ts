/**
 * "Test connection" for the SSO settings (R4.6): checks what can be checked without a person signing in. OIDC: the
 * discovery document and key set are fetched (through the SSRF guard) and the client secret decrypts. SAML: the SSO
 * URL is a public https URL and every certificate parses and is currently valid.
 */
import { X509Certificate } from "node:crypto";
import { decryptSecret } from "@/lib/crypto";
import { errorMessage } from "@/lib/log";
import type { SsoConnectionRow } from "./connections";
import { assertSsoUrl, ssoRequest, type SsoNetDeps } from "./net";
import { clearOidcCache, discover } from "./oidc";

export interface SsoCheckResult {
  ok: boolean;
  /** What was checked, one line each. */
  lines: string[];
}

export async function checkSsoConnection(connection: SsoConnectionRow, deps: SsoNetDeps, now: Date = new Date()): Promise<SsoCheckResult> {
  const lines: string[] = [];
  try {
    if (connection.protocol === "oidc") {
      clearOidcCache(connection.issuer);
      const discovery = await discover(connection.issuer, { ...deps, now: now.getTime() });
      lines.push(`Discovery document found for ${discovery.issuer}.`);
      const jwks = await ssoRequest(await assertSsoUrl(discovery.jwks_uri, deps, "The OIDC JWKS URL"), { headers: { accept: "application/json" } }, deps, "OIDC JWKS");
      const keys = jwks.body && typeof jwks.body === "object" && Array.isArray((jwks.body as { keys?: unknown }).keys) ? (jwks.body as { keys: unknown[] }).keys.length : 0;
      if (jwks.status !== 200 || keys === 0) throw new Error(`the JWKS endpoint returned ${jwks.status} with ${keys} keys`);
      lines.push(`Signing keys: ${keys}.`);
      if (!connection.clientSecretEnc) throw new Error("no client secret is stored");
      decryptSecret(connection.clientSecretEnc);
      lines.push("Client secret stored and readable.");
      return { ok: true, lines };
    }
    if (!connection.samlSsoUrl) throw new Error("no SSO URL is configured");
    await assertSsoUrl(connection.samlSsoUrl, deps, "The IdP SSO URL");
    lines.push(`SSO URL ${new URL(connection.samlSsoUrl).host} is allowed.`);
    if (!connection.samlCertificates.length) throw new Error("no IdP certificate is configured");
    for (const pem of connection.samlCertificates) {
      const cert = new X509Certificate(pem);
      const to = new Date(cert.validTo);
      const from = new Date(cert.validFrom);
      if (to < now || from > now) throw new Error(`the certificate for ${cert.subject.replace(/\n/g, ", ")} is not valid now (${from.toISOString()} – ${to.toISOString()})`);
      lines.push(`Certificate ${cert.subject.replace(/\n/g, ", ")} valid until ${to.toISOString().slice(0, 10)}.`);
    }
    return { ok: true, lines };
  } catch (err) {
    lines.push(`Failed: ${errorMessage(err)}`);
    return { ok: false, lines };
  }
}
