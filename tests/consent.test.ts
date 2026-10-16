import test from "node:test";
import assert from "node:assert/strict";
import { analyticsAllowed, browserRefuses, consentCookieValue, isAnalyticsStorageKey, needsChoice, readConsent } from "../src/consent";

test("the stored choice is read from the cookie string and nothing else", () => {
  assert.equal(readConsent(""), undefined);
  assert.equal(readConsent("openreview_theme=dark; openreview_consent=granted"), "granted");
  assert.equal(readConsent("openreview_consent=denied"), "denied");
  assert.equal(readConsent("openreview_consent=yes"), undefined, "unknown values are no choice");
  assert.equal(readConsent("xopenreview_consent=granted"), undefined);
});

test("the choice cookie is first-party, lax and lasts 180 days; Secure on HTTPS", () => {
  assert.equal(consentCookieValue("granted", true), "openreview_consent=granted; Path=/; Max-Age=15552000; SameSite=Lax; Secure");
  assert.equal(consentCookieValue("denied", false), "openreview_consent=denied; Path=/; Max-Age=15552000; SameSite=Lax");
});

test("analytics starts only after an explicit yes; Do Not Track and Global Privacy Control refuse", () => {
  const none = {};
  assert.equal(browserRefuses({ doNotTrack: "1" }), true);
  assert.equal(browserRefuses({ globalPrivacyControl: true }), true);
  assert.equal(browserRefuses({ doNotTrack: "0", globalPrivacyControl: false }), false);
  assert.equal(analyticsAllowed("", none), false, "no choice yet: nothing starts");
  assert.equal(analyticsAllowed("openreview_consent=denied", none), false);
  assert.equal(analyticsAllowed("openreview_consent=granted", none), true);
  assert.equal(analyticsAllowed("openreview_consent=granted", { globalPrivacyControl: true }), false);
});

test("the banner shows only when analytics is configured and no choice or refusal exists", () => {
  assert.equal(needsChoice(true, "", {}), true);
  assert.equal(needsChoice(false, "", {}), false, "self-hosted without PostHog never asks");
  assert.equal(needsChoice(true, "openreview_consent=denied", {}), false);
  assert.equal(needsChoice(true, "openreview_consent=granted", {}), false);
  assert.equal(needsChoice(true, "", { doNotTrack: "1" }), false, "the browser already said no");
});

test("only PostHog's own cookies and storage keys are cleared on refusal", () => {
  for (const key of ["ph_phc_abc_posthog", "__ph_opt_in_out_phc_abc"]) assert.equal(isAnalyticsStorageKey(key), true, key);
  for (const key of ["openreview_session", "openreview_consent", "theme", "photo"]) assert.equal(isAnalyticsStorageKey(key), false, key);
});
