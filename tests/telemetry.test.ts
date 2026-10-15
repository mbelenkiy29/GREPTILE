import test from "node:test";
import assert from "node:assert/strict";
import { posthogBeforeSend, posthogHosts, sanitizeUrl, scrubBreadcrumb, scrubSentryEvent, sentryDataCollection, tracesSampleRate } from "../src/telemetry";

test("URLs keep only allowlisted query parameters and never a fragment", () => {
  assert.equal(sanitizeUrl("https://openreview.tech/invite?token=secret123"), "https://openreview.tech/invite");
  assert.equal(sanitizeUrl("https://openreview.tech/api/auth/callback?code=abc&state=xyz"), "https://openreview.tech/api/auth/callback");
  assert.equal(sanitizeUrl("/dashboard/onboarding/plan?checkout=success&message=oops#top"), "/dashboard/onboarding/plan?checkout=success");
  assert.equal(sanitizeUrl("https://openreview.tech/?utm_source=x&ref=hn&email=a%40b.c"), "https://openreview.tech/?utm_source=x&ref=hn");
  assert.equal(sanitizeUrl("/dashboard/pulls?repository=acme%2Fsecret-repo"), "/dashboard/pulls");
  assert.equal(sanitizeUrl("not a url"), "not a url");
  assert.equal(sanitizeUrl("mailto:someone@example.com"), "mailto:someone@example.com");
});

test("PostHog events drop element captures on private pages and strip secrets everywhere", () => {
  const event = (name: string, url: string) => ({ event: name, properties: { $current_url: url, $referrer: "https://openreview.tech/invite?token=t0k", $pathname: new URL(url).pathname, title: "/plain?text=kept" }, $set: { $current_url: url }, $set_once: { $initial_current_url: url } });
  for (const name of ["$autocapture", "$rageclick", "$dead_click"]) {
    assert.equal(posthogBeforeSend(event(name, "https://openreview.tech/dashboard/pulls/123?x=1")), null, name);
    assert.equal(posthogBeforeSend(event(name, "https://openreview.tech/invite?token=abc")), null, name);
  }
  const landing = posthogBeforeSend(event("$autocapture", "https://openreview.tech/?utm_campaign=launch&token=abc"));
  assert.equal(landing?.properties.$current_url, "https://openreview.tech/?utm_campaign=launch", "public pages keep clicks");
  const pageview = posthogBeforeSend(event("$pageview", "https://openreview.tech/invite?token=abc"))!;
  assert.equal(pageview.properties.$current_url, "https://openreview.tech/invite");
  assert.equal(pageview.properties.$referrer, "https://openreview.tech/invite");
  assert.equal(pageview.$set?.$current_url, "https://openreview.tech/invite");
  assert.equal(pageview.$set_once?.$initial_current_url, "https://openreview.tech/invite");
  assert.equal(pageview.properties.title, "/plain?text=kept", "only URL-shaped property names are rewritten");
  assert.equal(posthogBeforeSend(null), null);
});

test("Sentry events carry no cookies, credentials, bodies, query strings or user details beyond the id", () => {
  const event = scrubSentryEvent({
    request: { url: "https://openreview.tech/invite?token=abc", query_string: "token=abc", cookies: { openreview_session: "jwt" }, data: "{\"code\":\"x\"}", headers: { cookie: "a=b", Authorization: "Bearer x", "x-openreview-token": "t", "stripe-signature": "s", "user-agent": "UA" } },
    breadcrumbs: [{ data: { from: "/invite?token=abc", to: "/dashboard?repository=acme%2Fsecret", url: "https://api.example.com/v1?key=k", method: "GET" } }],
    user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
  });
  assert.deepEqual(event.request, { url: "https://openreview.tech/invite", headers: { "user-agent": "UA" } });
  assert.deepEqual(event.breadcrumbs?.[0].data, { from: "/invite", to: "/dashboard", url: "https://api.example.com/v1", method: "GET" });
  assert.deepEqual(event.user, { id: "u1" });
  assert.deepEqual(scrubBreadcrumb({ data: { to: "/fix?token=x" } }).data, { to: "/fix" });
  // The SDK itself collects none of the sensitive categories.
  assert.equal(sentryDataCollection.cookies, false);
  assert.deepEqual(sentryDataCollection.httpBodies, []);
  assert.deepEqual(sentryDataCollection.genAI, { inputs: false, outputs: false });
  assert.equal(sentryDataCollection.stackFrameVariables, false);
});

test("sampling and hosts default safely", () => {
  assert.equal(tracesSampleRate(undefined), 0.1);
  assert.equal(tracesSampleRate(""), 0.1);
  assert.equal(tracesSampleRate("0"), 0);
  assert.equal(tracesSampleRate("0.25"), 0.25);
  assert.equal(tracesSampleRate("2"), 0.1);
  assert.equal(tracesSampleRate("abc"), 0.1);
  assert.deepEqual(posthogHosts("https://us.i.posthog.com"), { api: "https://us.i.posthog.com", assets: "https://us-assets.i.posthog.com", ui: "https://us.posthog.com" });
  assert.deepEqual(posthogHosts("https://eu.i.posthog.com"), { api: "https://eu.i.posthog.com", assets: "https://eu-assets.i.posthog.com", ui: "https://eu.posthog.com" });
  assert.deepEqual(posthogHosts("https://ph.example.com"), { api: "https://ph.example.com", assets: "https://ph.example.com", ui: "https://ph.example.com" });
});
