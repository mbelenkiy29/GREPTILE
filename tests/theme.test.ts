import test from "node:test";
import assert from "node:assert/strict";
import { readTheme, themeCookieValue, themeScript } from "../src/theme";

// Runs the inline <head> script against a cookie string and returns the data-theme it sets.
function applied(cookie: string) {
  const document = { cookie, documentElement: { dataset: {} as Record<string, string> } };
  new Function("document", themeScript)(document);
  return document.documentElement.dataset.theme;
}

test("the saved theme is read from the cookie string; anything else is System", () => {
  assert.equal(readTheme(""), "system");
  assert.equal(readTheme("openreview_consent=granted; openreview_theme=dark"), "dark");
  assert.equal(readTheme("openreview_theme=light"), "light");
  assert.equal(readTheme("openreview_theme=system"), "system");
  assert.equal(readTheme("openreview_theme=blue"), "system", "unknown values are System");
  assert.equal(readTheme("xopenreview_theme=dark"), "system");
});

test("the head script applies the same choice as readTheme before first paint", () => {
  for (const cookie of ["", "openreview_theme=dark", "openreview_consent=granted; openreview_theme=light", "openreview_consent=granted;openreview_theme=dark", "openreview_theme=system", "openreview_theme=darker", "openreview_theme=blue", "xopenreview_theme=dark", "openreview_theme=dark; other=1"]) {
    assert.equal(applied(cookie), readTheme(cookie), JSON.stringify(cookie));
  }
});

test("the theme cookie is first-party, lax and lasts a year; Secure on HTTPS", () => {
  assert.equal(themeCookieValue("dark", true), "openreview_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.equal(themeCookieValue("system", false), "openreview_theme=system; Path=/; Max-Age=31536000; SameSite=Lax");
});
