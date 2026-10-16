import test from "node:test";
import assert from "node:assert/strict";
import { authMessage, authPagePath, authProviders } from "../src/auth-pages";

test("sign-in pages offer only the providers configured on this deployment, GitHub first", () => {
  assert.deepEqual(authProviders({}), []);
  assert.deepEqual(authProviders({ GITHUB_CLIENT_ID: "gh" }), ["github"]);
  assert.deepEqual(authProviders({ GOOGLE_CLIENT_ID: "g", GITLAB_OAUTH_CLIENT_ID: "gl", GITHUB_CLIENT_ID: "gh" }), ["github", "google", "gitlab"]);
  assert.deepEqual(authProviders({ GITHUB_CLIENT_ID: "", GOOGLE_CLIENT_ID: "g" }), ["google"]);
  assert.deepEqual(authProviders({ GITHUB_CLIENT_ID: "gh", GOOGLE_CLIENT_ID: "g", OPENREVIEW_OFFLINE: "true" }), ["github"], "offline installs never offer Google");
});

test("email sign-in returns to the page it started from; anything else goes to sign in", () => {
  assert.equal(authPagePath("signup"), "/signup");
  assert.equal(authPagePath("login"), "/login");
  assert.equal(authPagePath("https://evil.example"), "/login");
  assert.equal(authPagePath(null), "/login");
});

test("redirect results become one plain message, errors first", () => {
  assert.equal(authMessage({}), null);
  assert.deepEqual(authMessage({ error: "link" })?.tone, "alert");
  assert.match(authMessage({ error: "link" })!.text, /expired or already used/);
  assert.match(authMessage({ error: "signin" })!.text, /didn’t finish/);
  assert.match(authMessage({ error: "sso" })!.text, /Single sign-on/);
  assert.match(authMessage({ error: "<script>" })!.text, /didn’t finish/, "unknown codes get the generic message, never echoed");
  assert.deepEqual(authMessage({ email: "sent" }), { tone: "status", text: "Check your inbox. The sign-in link expires in 15 minutes." });
  assert.equal(authMessage({ email: "error" })?.tone, "alert");
  assert.equal(authMessage({ signedout: "1" })?.tone, "status");
  assert.equal(authMessage({ error: "signin", email: "sent" })?.tone, "alert");
});
