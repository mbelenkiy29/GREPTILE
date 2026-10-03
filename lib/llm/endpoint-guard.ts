import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { LlmError } from "./types";

/**
 * Guards organization-supplied (bring-your-own) LLM endpoints against server-side request forgery. An org's base URL
 * must be https, carry no credentials, and point at a public address: loopback, private, link-local, CGNAT,
 * multicast, reserved, and cloud-metadata addresses are refused, both as IP literals and as what a hostname
 * resolves to. Operators who want orgs to reach internal endpoints set LLM_ALLOW_PRIVATE_ORG_ENDPOINTS=true.
 * The operator's own LLM_BASE_URL is never restricted (a local Ollama is legitimate).
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the 169.254.169.254 metadata service
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local (includes fd00:ec2::254, the AWS IPv6 metadata service)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/**
 * True for addresses an org endpoint may not target. `address` is an IPv4 or IPv6 literal (no brackets).
 * BlockList matches IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) against the IPv4 rules, so those cannot smuggle a
 * private IPv4 address.
 */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true;
}

function hostOf(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * Synchronous checks on an org base URL: parseable, no credentials, and (unless private endpoints are allowed)
 * https with a host that is not a non-public IP literal or a localhost name. Throws LlmError.
 */
export function assertOrgEndpointShape(baseURL: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new LlmError("the organization's LLM base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LlmError("the organization's LLM base URL must use https");
  }
  if (url.username || url.password) {
    throw new LlmError("the organization's LLM base URL must not contain credentials; use the API key setting");
  }
  if (allowPrivate) return url;
  if (url.protocol !== "https:") throw new LlmError("the organization's LLM base URL must use https");
  const host = hostOf(url).toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new LlmError("the organization's LLM base URL must not point at a local address");
  }
  if (isIP(host) && isNonPublicAddress(host)) {
    throw new LlmError("the organization's LLM base URL must not point at a private, loopback, or link-local address");
  }
  return url;
}

/** Resolves a hostname to every address it maps to. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const resolveHost: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Full check of an org base URL: the synchronous rules, then (unless private endpoints are allowed) every address
 * its hostname resolves to must be public. Throws LlmError.
 */
export async function assertPublicOrgEndpoint(baseURL: string, opts: { allowPrivate: boolean; resolve?: HostResolver }): Promise<void> {
  const url = assertOrgEndpointShape(baseURL, opts.allowPrivate);
  if (opts.allowPrivate) return;
  const host = hostOf(url);
  if (isIP(host)) return;
  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? resolveHost)(host);
  } catch (err) {
    throw new LlmError(`cannot resolve the organization's LLM endpoint host ${host}`, { retryable: false, cause: err });
  }
  if (addresses.length === 0) throw new LlmError(`the organization's LLM endpoint host ${host} has no addresses`);
  if (addresses.some(isNonPublicAddress)) {
    throw new LlmError(`the organization's LLM endpoint host ${host} resolves to a private, loopback, or link-local address`);
  }
}
