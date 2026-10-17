import test from "node:test";
import assert from "node:assert/strict";
import { readTheme, themeCookie, themeCookieValue, themePattern, themeScript } from "../src/theme";

test("the saved theme is read from the cookie string; anything else is System", () => {
  assert.equal(readTheme(""), "system");
  assert.equal(readTheme("openreview_consent=granted; openreview_theme=dark"), "dark");
  assert.equal(readTheme("openreview_consent=granted;openreview_theme=light"), "light");
  assert.equal(readTheme("openreview_theme=light"), "light");
  assert.equal(readTheme("openreview_theme=dark; other=1"), "dark");
  assert.equal(readTheme("openreview_theme=system"), "system");
  assert.equal(readTheme("openreview_theme=blue"), "system", "unknown values are System");
  assert.equal(readTheme("openreview_theme=darker"), "system");
  assert.equal(readTheme("xopenreview_theme=dark"), "system");
});

test("the head script applies readTheme's rule to <html data-theme>", () => {
  assert.ok(themePattern.source.includes(themeCookie));
  assert.ok(themeScript.includes(`document.cookie.match(/${themePattern.source}/)`), "same pattern as readTheme");
  assert.ok(themeScript.includes(`document.documentElement.dataset.theme=m?m[1]:"system"`), "System when nothing is saved");
  assert.ok(!themeScript.includes("</"), "safe to inline in a <script> element");
});

test("the theme cookie is first-party, lax and lasts a year; Secure on HTTPS", () => {
  assert.equal(themeCookieValue("dark", true), "openreview_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.equal(themeCookieValue("system", false), "openreview_theme=system; Path=/; Max-Age=31536000; SameSite=Lax");
});
