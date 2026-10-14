import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gitlabAuthorizeUrl, gitlabProfile, googleAuthorizeUrl, googleProfile, newSession, safeNext } from "../src/identity";

const fake = (routes: Record<string, unknown>) => (async (input: string | URL | Request) => { const url = String(input).split("?")[0]; return url in routes ? Response.json(routes[url]) : new Response("no", { status: 404 }); }) as typeof fetch;

test("post-sign-in redirects stay on this origin", () => {
  assert.equal(safeNext("/invite?token=abc_123"), "/invite?token=abc_123");
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "/a b", "", null, undefined]) assert.equal(safeNext(bad), "/dashboard", String(bad));
});

test("session IDs are random and stored only as their SHA-256", () => {
  const a = newSession(), b = newSession();
  assert.notEqual(a.sid, b.sid);
  assert.match(a.sid, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.hash, createHash("sha256").update(a.sid).digest("hex"));
});

test("GitLab profiles: confirmed gitlab.com emails are verified; self-managed emails never are", async () => {
  delete process.env.GITLAB_OAUTH_URL;
  assert.match(gitlabAuthorizeUrl("cid", "https://r.example/api/auth/gitlab/callback", "st"), /^https:\/\/gitlab\.com\/oauth\/authorize\?client_id=cid&.*scope=read_user/);
  const user = { id: 42, username: "dev", avatar_url: "https://gitlab.com/a.png", email: "dev@example.com", confirmed_at: "2024-01-01T00:00:00Z" };
  assert.deepEqual(await gitlabProfile("code", "https://r/cb", fake({ "https://gitlab.com/oauth/token": { access_token: "t" }, "https://gitlab.com/api/v4/user": user })), { providerUserId: "42", login: "dev", avatar: "https://gitlab.com/a.png", email: "dev@example.com", emailVerified: true });
  assert.equal((await gitlabProfile("code", "https://r/cb", fake({ "https://gitlab.com/oauth/token": { access_token: "t" }, "https://gitlab.com/api/v4/user": { ...user, confirmed_at: null } }))).emailVerified, false);
  process.env.GITLAB_OAUTH_URL = "https://gitlab.acme.internal";
  try {
    assert.equal((await gitlabProfile("code", "https://r/cb", fake({ "https://gitlab.acme.internal/oauth/token": { access_token: "t" }, "https://gitlab.acme.internal/api/v4/user": user }))).emailVerified, false);
    process.env.GITLAB_OAUTH_URL = "http://gitlab.acme.internal";
    assert.throws(() => gitlabAuthorizeUrl("cid", "https://r/cb", "st"), /HTTPS origin/);
  } finally { delete process.env.GITLAB_OAUTH_URL; }
  await assert.rejects(gitlabProfile("code", "https://r/cb", fake({})), /exchange failed/);
});

test("Google profiles trust email only when Google marks it verified", async () => {
  assert.match(googleAuthorizeUrl("cid", "https://r/cb", "st"), /scope=openid\+email\+profile/);
  const routes = (info: Record<string, unknown>) => fake({ "https://oauth2.googleapis.com/token": { access_token: "t" }, "https://openidconnect.googleapis.com/v1/userinfo": info });
  assert.deepEqual(await googleProfile("c", "https://r/cb", routes({ sub: "g-1", email: "Dev@Example.com", email_verified: true, picture: "https://p/x.png" })), { providerUserId: "g-1", login: "Dev", avatar: "https://p/x.png", email: "Dev@Example.com", emailVerified: true });
  assert.equal((await googleProfile("c", "https://r/cb", routes({ sub: "g-2", email: "x@example.com", email_verified: false }))).emailVerified, false);
  assert.equal((await googleProfile("c", "https://r/cb", routes({ sub: "g-3", email: "x@example.com" }))).emailVerified, false);
});
