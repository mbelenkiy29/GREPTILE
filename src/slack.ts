import { z } from "zod";
import { assertEgress } from "./egress";

// Slack app support. Uses Web Crypto and fetch only, so it runs in Convex HTTP actions, Node
// actions and tests alike. Request text from Slack is untrusted data.
const encoder = new TextEncoder();
export async function verifySlackSignature(body: string, timestamp: string | null, signature: string | null, secret: string | undefined, now = Date.now()) {
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`)));
  const provided = signature.slice(3).match(/../g)!.map((b) => parseInt(b, 16));
  let difference = 0;
  for (let i = 0; i < mac.length; i++) difference |= mac[i] ^ provided[i];
  return difference === 0;
}

export const slackScopes = ["app_mentions:read", "chat:write", "commands"] as const;
export function slackAuthorizeUrl(clientId: string, redirectUri: string, state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", slackScopes.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}
const oauthResponse = z.object({ ok: z.literal(true), access_token: z.string().startsWith("xoxb-"), bot_user_id: z.string().regex(/^[UW][A-Z0-9]+$/), team: z.object({ id: z.string().regex(/^T[A-Z0-9]+$/), name: z.string().max(200) }), scope: z.string() });
export async function exchangeSlackCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, fetchImpl: typeof fetch = fetch) {
  assertEgress("slack", "Slack");
  const response = await fetchImpl("https://slack.com/api/oauth.v2.access", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri }), redirect: "error", signal: AbortSignal.timeout(15000) });
  const parsed = oauthResponse.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new Error("Slack authorization failed");
  const granted = parsed.data.scope.split(",");
  if (slackScopes.some((s) => !granted.includes(s))) throw new Error("Slack authorization is missing required scopes");
  return { token: parsed.data.access_token, botUserId: parsed.data.bot_user_id, teamId: parsed.data.team.id, teamName: parsed.data.team.name };
}

export class SlackError extends Error { constructor(readonly code: string) { super(`Slack API error: ${code}`); } }
export class SlackApi {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}
  private async call<T>(method: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    assertEgress("slack", "Slack");
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15000) });
    const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !data?.ok) throw new SlackError(String(data?.error ?? `http_${response.status}`).slice(0, 60));
    return schema.parse(data);
  }
  postMessage(message: { channel: string; text: string; threadTs?: string }) {
    return this.call("chat.postMessage", { channel: message.channel, text: message.text.slice(0, 39000), ...(message.threadTs ? { thread_ts: message.threadTs } : {}), unfurl_links: false, unfurl_media: false }, z.object({ ts: z.string() }));
  }
  updateMessage(message: { channel: string; ts: string; text: string }) {
    return this.call("chat.update", { channel: message.channel, ts: message.ts, text: message.text.slice(0, 39000) }, z.object({ ts: z.string() }));
  }
}

// Slack mrkdwn escaping for untrusted text; links are built only from our own URLs.
export const escapeSlack = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const slackLink = (url: string, label: string) => `<${url.replace(/[<>|\s]/g, encodeURIComponent)}|${escapeSlack(label).replace(/\|/g, "¦")}>`;
// The question in an app mention, without the bot's own mention and with other mentions neutralised.
export function mentionQuestion(text: string, botUserId: string) {
  return text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), " ").replace(/<!(channel|here|everyone)[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
}
export const slackChannelId = z.string().regex(/^[CG][A-Z0-9]{8,12}$/, "Use a Slack channel ID such as C0123456789");
