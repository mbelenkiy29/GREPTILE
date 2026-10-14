import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { providerOrigin } from "./credentials";

// Network settings for self-managed code hosts behind corporate infrastructure: an internal API URL
// (the connection's instance URL stays the external web URL used in links), extra trusted CA
// certificates, and an HTTPS proxy the operator authorized in SCM_ALLOWED_PROXIES. Redirects are
// followed only within the same origin, so the access token never reaches another host.
export type ScmNetwork = { apiUrl?: string; caBundle?: string; proxyUrl?: string };
type Env = Record<string, string | undefined>;
const certificateBlock = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;

export function caCertificates(pem: string, now = Date.now()) {
  if (pem.length > 65_536) throw new Error("The CA bundle is larger than 64 KB");
  const blocks = pem.match(certificateBlock) ?? [];
  if (!blocks.length || pem.replace(certificateBlock, "").trim()) throw new Error("The CA bundle must contain only PEM certificates");
  if (blocks.length > 20) throw new Error("The CA bundle holds more than 20 certificates");
  for (const block of blocks) {
    let certificate: X509Certificate;
    try { certificate = new X509Certificate(block); } catch { throw new Error("A certificate in the CA bundle could not be parsed"); }
    if (Date.parse(certificate.validTo) < now) throw new Error(`A certificate in the CA bundle has expired (${certificate.subject.replace(/\n/g, ", ").slice(0, 200)})`);
  }
  return blocks;
}
export function proxyOrigin(raw: string, env: Env = process.env) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("The proxy must be a URL such as http://proxy.internal:3128"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("The proxy must be http(s)://host:port without credentials or a path");
  const allowed = (env.SCM_ALLOWED_PROXIES ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  if (!allowed.includes(url.host)) throw new Error("Operator must authorize this proxy in SCM_ALLOWED_PROXIES");
  return url.origin;
}
// Validates stored or submitted settings; the API URL obeys the same allowlist as the instance URL.
export function scmNetwork(input: ScmNetwork, builtin: string[] = [], env: Env = process.env): ScmNetwork {
  const apiUrl = input.apiUrl?.trim(), caBundle = input.caBundle?.trim(), proxyUrl = input.proxyUrl?.trim();
  return {
    ...(apiUrl ? { apiUrl: providerOrigin(apiUrl, builtin) } : {}),
    ...(caBundle ? { caBundle: caCertificates(caBundle).join("\n") } : {}),
    ...(proxyUrl ? { proxyUrl: proxyOrigin(proxyUrl, env) } : {}),
  };
}
export const connectionNetwork = (c: { kind: string; apiUrl?: string; caBundle?: string; proxyUrl?: string }) =>
  c.kind === "gitlab" ? scmNetwork({ apiUrl: c.apiUrl, caBundle: c.caBundle, proxyUrl: c.proxyUrl }, ["gitlab.com"]) : {};

type Fetcher = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;
export type TransportDeps = { fetch?: Fetcher; agent?: (options: Agent.Options) => Dispatcher; proxy?: (options: ProxyAgent.Options) => Dispatcher };

// Custom CAs are added to Node's bundled roots, so public certificates keep working.
export function dispatcherFor(network: ScmNetwork, deps: TransportDeps = {}) {
  const ca = network.caBundle ? [...rootCertificates, ...caCertificates(network.caBundle)] : undefined;
  if (network.proxyUrl) return (deps.proxy ?? ((o) => new ProxyAgent(o)))({ uri: network.proxyUrl, ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {}) });
  if (ca) return (deps.agent ?? ((o) => new Agent(o)))({ connect: { ca } });
  return undefined;
}
const redirects = new Set([301, 302, 303, 307, 308]);
export function scmFetch(network: ScmNetwork = {}, deps: TransportDeps = {}) {
  const dispatcher = dispatcherFor(network, deps);
  const send: Fetcher = deps.fetch ?? (dispatcher ? (url, init) => undiciFetch(url, init as never) as unknown as Promise<Response> : (url, init) => fetch(url, init));
  return async (url: string, init: RequestInit): Promise<Response> => {
    let current = new URL(url);
    const origin = current.origin, method = (init.method ?? "GET").toUpperCase();
    for (let hop = 0; ; hop++) {
      const response = await send(current.toString(), { ...init, redirect: "manual", ...(dispatcher ? { dispatcher } : {}) });
      if (!redirects.has(response.status)) return response;
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error(`Provider redirect (${response.status}) without a location`);
      const next = new URL(location, current);
      if (next.origin !== origin) throw new Error(`Provider redirected to another host (${next.host}); only same-host redirects are followed`);
      if (method !== "GET" && method !== "HEAD") throw new Error("Provider redirected a write request; it was not repeated");
      if (hop >= 5) throw new Error("Too many provider redirects");
      current = next;
    }
  };
}
