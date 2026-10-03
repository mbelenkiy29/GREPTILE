/**
 * SAML IdP metadata parsing (R4.6): the entity id, the SSO endpoint (HTTP-Redirect binding), and the signing
 * certificates, from the metadata XML an admin pastes. The XML is untrusted input: it is size-limited, parsed without
 * DTDs or external entities (xmldom resolves none), and only these three values are read from it.
 */
import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";

const MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const MAX_BYTES = 500_000;

export interface IdpMetadata {
  entityId: string;
  ssoUrl: string;
  certificates: string[];
}

export class MetadataError extends Error {
  readonly field = "samlMetadata";
}

function toPem(base64: string): string {
  const clean = base64.replace(/\s+/g, "");
  return `-----BEGIN CERTIFICATE-----\n${(clean.match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----`;
}

function elements(parent: { getElementsByTagNameNS(ns: string, name: string): ArrayLike<XmlElement> }, ns: string, name: string): XmlElement[] {
  return Array.from(parent.getElementsByTagNameNS(ns, name));
}

export function parseIdpMetadata(xml: string): IdpMetadata {
  if (xml.length > MAX_BYTES) throw new MetadataError("The metadata XML is too large.");
  if (/<!DOCTYPE/i.test(xml)) throw new MetadataError("Metadata with a DOCTYPE is not accepted.");
  let doc;
  try {
    doc = new DOMParser({ onError: (level, msg) => {
      if (level !== "warning") throw new Error(msg);
    } }).parseFromString(xml, "text/xml");
  } catch {
    throw new MetadataError("The metadata is not valid XML.");
  }
  const entity = elements(doc, MD, "EntityDescriptor")[0];
  const entityId = entity?.getAttribute("entityID")?.trim();
  if (!entity || !entityId) throw new MetadataError("The metadata has no EntityDescriptor entityID.");
  const idp = elements(entity, MD, "IDPSSODescriptor")[0];
  if (!idp) throw new MetadataError("The metadata has no IDPSSODescriptor (is it the identity provider's metadata?).");
  const sso = elements(idp, MD, "SingleSignOnService").find((e) => e.getAttribute("Binding") === REDIRECT);
  const ssoUrl = sso?.getAttribute("Location")?.trim();
  if (!ssoUrl) throw new MetadataError("The metadata has no HTTP-Redirect SingleSignOnService location.");
  const certificates = elements(idp, MD, "KeyDescriptor")
    .filter((k) => {
      const use = k.getAttribute("use");
      return !use || use === "signing";
    })
    .flatMap((k) => elements(k, DS, "X509Certificate"))
    .map((c) => (c.textContent ?? "").trim())
    .filter((c) => c.length > 0)
    .map(toPem);
  if (!certificates.length) throw new MetadataError("The metadata has no signing certificate.");
  return { entityId, ssoUrl, certificates: [...new Set(certificates)] };
}
