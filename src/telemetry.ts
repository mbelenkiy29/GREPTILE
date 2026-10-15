// Error tracking (Sentry) and product analytics (PostHog) for the hosted site. Both are off unless
// their public keys are set at build time, so self-hosted installs send nothing anywhere.
// Shared by the browser, server and edge setup files: no SDK imports here.
export const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;
export const posthogToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || undefined;
export const posthogHost = (process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/+$/, "");
// Same-origin paths (not obviously analytics) so ad blockers keep events flowing.
export const posthogProxyPath = "/lantern";
export const sentryTunnelPath = "/lighthouse";
export const telemetryEnvironment = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "development";

/** Trace sampling for Sentry performance: NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE (0–1), default 0.1. */
export function tracesSampleRate(value = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE) {
  const rate = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.1;
}
/** PostHog's asset and app hosts for an ingestion host such as https://us.i.posthog.com. */
export function posthogHosts(host = posthogHost) {
  const region = /^https:\/\/(us|eu)\.i\.posthog\.com$/.exec(host)?.[1];
  return region
    ? { api: host, assets: `https://${region}-assets.i.posthog.com`, ui: `https://${region}.posthog.com` }
    : { api: host, assets: host, ui: host };
}

// Query parameters worth keeping; everything else (invite tokens, OAuth codes and state, error
// messages, filters naming private repositories) is dropped before it leaves the browser or server.
const keptParams = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "checkout", "billing", "signedout"]);
/** A URL without secrets: only allowlisted query parameters, never a fragment. Non-URLs pass through. */
export function sanitizeUrl(value: string): string {
  const relative = value.startsWith("/");
  if (!relative && !/^https?:\/\//i.test(value)) return value;
  let url: URL;
  try { url = new URL(value, "https://openreview.invalid"); } catch { return value; }
  for (const key of [...url.searchParams.keys()]) if (!keptParams.has(key)) url.searchParams.delete(key);
  url.hash = "";
  return relative ? url.pathname + url.search : url.toString();
}
const looksLikeUrl = (value: string) => /^(https?:\/\/|\/)/.test(value);
// PostHog: URL-shaped properties only. Sentry breadcrumbs: every URL-looking value (from, to, url).
function sanitizeRecord(record: Record<string, unknown> | undefined, everyKey = false) {
  if (!record) return;
  for (const [key, value] of Object.entries(record))
    if (typeof value === "string" && looksLikeUrl(value) && (everyKey || /url|referrer|href|pathname|path/i.test(key))) record[key] = sanitizeUrl(value);
}

// Signed-in pages show private repositories, code and findings: no click text or element data is
// captured there, only page views and explicit events.
const privatePath = /^\/(dashboard|invite|fix|api)(\/|$)/;
const pathOf = (url: unknown) => {
  if (typeof url !== "string") return "";
  try { return new URL(url, "https://openreview.invalid").pathname; } catch { return ""; }
};
type PosthogEvent = { event: string; properties: Record<string, unknown>; $set?: Record<string, unknown>; $set_once?: Record<string, unknown> };
/** PostHog `before_send`: drops element captures on private pages and strips secrets from URLs. */
export function posthogBeforeSend<T extends PosthogEvent>(event: T | null): T | null {
  if (!event) return null;
  if (["$autocapture", "$rageclick", "$dead_click"].includes(event.event) && privatePath.test(pathOf(event.properties.$current_url) || pathOf(event.properties.$pathname))) return null;
  sanitizeRecord(event.properties);
  sanitizeRecord(event.$set);
  sanitizeRecord(event.$set_once);
  return event;
}

// Sentry v11 collects cookies, headers, bodies, query strings, local variables and AI prompts by
// default. Reviews carry customers' code, so all of that is off; errors keep stack traces and the
// user id set after sign-in.
export const sentryDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ["user-agent", "content-type"] }, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  stackFrameVariables: false,
};

type SentryLikeEvent = {
  request?: { url?: string; query_string?: unknown; cookies?: unknown; headers?: Record<string, string>; data?: unknown };
  breadcrumbs?: { data?: Record<string, unknown> }[];
  user?: Record<string, unknown>;
};
const secretHeaders = /^(cookie|authorization|x-[a-z0-9-]*(token|secret|key|signature)[a-z0-9-]*|stripe-signature)$/i;
/** Sentry `beforeSend`: no cookies, credentials, request bodies, IPs or secret query parameters. */
export function scrubSentryEvent<T extends SentryLikeEvent>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = sanitizeUrl(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) for (const name of Object.keys(event.request.headers)) if (secretHeaders.test(name)) delete event.request.headers[name];
  }
  for (const crumb of event.breadcrumbs ?? []) sanitizeRecord(crumb.data, true);
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  return event;
}
/** Sentry `beforeBreadcrumb`: navigation and request breadcrumbs keep only sanitized URLs. */
export function scrubBreadcrumb<T extends { data?: Record<string, unknown> }>(crumb: T): T {
  sanitizeRecord(crumb.data, true);
  return crumb;
}
