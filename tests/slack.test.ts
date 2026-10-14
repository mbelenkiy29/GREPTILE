import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { exchangeSlackCode, mentionQuestion, slackAuthorizeUrl, SlackApi, slackLink, verifySlackSignature, escapeSlack } from "../src/slack";
import { emailReview, slackReviewText, type ReviewNotice } from "../src/notifications";
import { sendEmail } from "../src/email";

const secret = "slack-signing-secret-fixture";
const sign = (body: string, ts: string, key = secret) => "v0=" + createHmac("sha256", key).update(`v0:${ts}:${body}`).digest("hex");

test("Slack request signatures: exact body, current timestamp and the signing secret are all required", async () => {
  const body = '{"type":"event_callback"}', now = 1_760_000_000_000, ts = String(now / 1000);
  assert.equal(await verifySlackSignature(body, ts, sign(body, ts), secret, now), true);
  assert.equal(await verifySlackSignature(body + " ", ts, sign(body, ts), secret, now), false);
  assert.equal(await verifySlackSignature(body, ts, sign(body, ts, "other-secret"), secret, now), false);
  assert.equal(await verifySlackSignature(body, String(now / 1000 - 301), sign(body, String(now / 1000 - 301)), secret, now), false, "replayed after five minutes");
  assert.equal(await verifySlackSignature(body, ts, sign(body, ts).toUpperCase(), secret, now), false);
  assert.equal(await verifySlackSignature(body, ts, null, secret, now), false);
  assert.equal(await verifySlackSignature(body, null, sign(body, ts), secret, now), false);
  assert.equal(await verifySlackSignature(body, ts, sign(body, ts), undefined, now), false, "unconfigured secret rejects everything");
  assert.equal(await verifySlackSignature(body, "12abc", sign(body, ts), secret, now), false);
});

test("Slack OAuth: authorize URL requests only the needed scopes; the code exchange validates the grant", async () => {
  const url = new URL(slackAuthorizeUrl("123.456", "https://review.example.com/api/slack/callback", "state-1"));
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(url.searchParams.get("scope"), "app_mentions:read,chat:write,commands");
  assert.equal(url.searchParams.get("state"), "state-1");
  const grant = { ok: true, access_token: "xoxb-1-2-abc", bot_user_id: "U0BOT1234", team: { id: "T0TEAM123", name: "Acme" }, scope: "app_mentions:read,chat:write,commands" };
  let sent: URLSearchParams | undefined;
  const fake = (payload: unknown, status = 200) => (async (_url: string | URL | Request, init?: RequestInit) => { sent = new URLSearchParams(String(init?.body)); return Response.json(payload, { status }); }) as typeof fetch;
  assert.deepEqual(await exchangeSlackCode({ clientId: "123.456", clientSecret: "shh", code: "c0de", redirectUri: "https://r/cb" }, fake(grant)), { token: "xoxb-1-2-abc", botUserId: "U0BOT1234", teamId: "T0TEAM123", teamName: "Acme" });
  assert.equal(sent?.get("code"), "c0de");
  await assert.rejects(exchangeSlackCode({ clientId: "1", clientSecret: "2", code: "3", redirectUri: "4" }, fake({ ...grant, scope: "chat:write" })), /missing required scopes/);
  await assert.rejects(exchangeSlackCode({ clientId: "1", clientSecret: "2", code: "3", redirectUri: "4" }, fake({ ok: false, error: "invalid_code" })), /authorization failed/);
  await assert.rejects(exchangeSlackCode({ clientId: "1", clientSecret: "2", code: "3", redirectUri: "4" }, fake({ ...grant, access_token: "xoxp-user-token" })), /authorization failed/);
});

test("Slack API calls surface Slack error codes; text is escaped and mentions neutralised", async () => {
  const api = new SlackApi("xoxb-t", (async () => Response.json({ ok: false, error: "channel_not_found" })) as typeof fetch);
  await assert.rejects(api.postMessage({ channel: "C0123456789", text: "hi" }), /channel_not_found/);
  let body: Record<string, unknown> = {};
  const ok = new SlackApi("xoxb-t", (async (_u: string | URL | Request, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json({ ok: true, ts: "1.2" }); }) as typeof fetch);
  assert.deepEqual(await ok.postMessage({ channel: "C0123456789", text: "hi", threadTs: "9.9" }), { ts: "1.2" });
  assert.equal(body.thread_ts, "9.9");assert.equal(body.unfurl_links, false);
  assert.equal(escapeSlack("<!channel> & <@U1>"), "&lt;!channel&gt; &amp; &lt;@U1&gt;");
  assert.equal(slackLink("https://x.example/a b", "a|b <c>"), "<https://x.example/a%20b|a¦b &lt;c&gt;>");
  assert.equal(mentionQuestion("<@U0BOT1234> where is <!here> total computed?", "U0BOT1234"), "where is total computed?");
});

const notice: ReviewNotice = { repository: "acme/shop", prNumber: 7, prTitle: "Totals <script>", prUrl: "https://github.com/acme/shop/pull/7", reviewUrl: "https://review.example.com/dashboard/pulls/r1", headSha: "a".repeat(40), findings: [{ title: "Cents become dollars", severity: "high", filePath: "src/cart.ts", startLine: 2 }, { title: "Typo", severity: "low", filePath: "README.md", startLine: 1 }] };
test("notification content: high-severity events list only high findings; untrusted text is escaped", async () => {
  const high = slackReviewText("finding.high", notice);
  assert.match(high, /^\*1 high-severity finding in acme\/shop#7\*/);
  assert.match(high, /Totals &lt;script&gt;/);
  assert.doesNotMatch(high, /Typo/);
  assert.match(slackReviewText("review.completed", notice), /2 findings[\s\S]*Typo/);
  const email = emailReview("review.completed", notice);
  assert.equal(email.subject, "OpenReview finished reviewing acme/shop#7: 2 findings");
  assert.match(email.text, /View the review: https:\/\/review\.example\.com\/dashboard\/pulls\/r1/);
});

test("email sends through Resend only when configured", async () => {
  delete process.env.RESEND_API_KEY;
  assert.deepEqual(await sendEmail({ to: "a@example.com", subject: "s", text: "t" }), { skipped: "Email delivery is not configured" });
  process.env.RESEND_API_KEY = "re_fixture"; process.env.EMAIL_FROM = "OpenReview <noreply@example.com>";
  try {
    let request: { url: string; init?: RequestInit } | undefined;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => { request = { url: String(url), init }; return Response.json({ id: "email_1" }); }) as typeof fetch;
    assert.deepEqual(await sendEmail({ to: "A@Example.com", subject: "Hi\nthere", text: "body" }, fake), { id: "email_1" });
    assert.equal(request?.url, "https://api.resend.com/emails");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), { from: "OpenReview <noreply@example.com>", to: ["a@example.com"], subject: "Hi there", text: "body" });
    await assert.rejects(sendEmail({ to: "not-an-email", subject: "s", text: "t" }, fake));
    await assert.rejects(sendEmail({ to: "a@example.com", subject: "s", text: "t" }, (async () => Response.json({ message: "bad" }, { status: 422 })) as typeof fetch), /HTTP 422/);
  } finally { delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; }
});
