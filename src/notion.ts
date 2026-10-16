import { z } from "zod";
import { assertEgress } from "./egress";

// Notion public-integration OAuth (https://developers.notion.com/docs/authorization) and read-only
// page retrieval. Pages are reachable only if the user shared them with the integration in
// Notion's page picker; OpenReview fetches only pages linked in the PR text. Page content is
// untrusted requirements data.
export const notionVersion = "2022-06-28";
export class NotionError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export const notionCredentials = z.object({ accessToken: z.string().min(10), refreshToken: z.string().min(10).nullable(), expiresAt: z.number().finite().positive() });
export type NotionCredentials = z.infer<typeof notionCredentials>;
function callback(value: string) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)))) throw new Error("Notion callback requires HTTPS or local development");
  return value;
}
export function notionAuthorization(clientId: string, redirectUri: string, state: string) {
  if (!clientId || !/^[a-zA-Z0-9_-]{32,128}$/.test(state)) throw new Error("Invalid Notion OAuth parameters");
  return "https://api.notion.com/v1/oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: callback(redirectUri), response_type: "code", owner: "user", state });
}
const basic = (clientId: string, clientSecret: string) => "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
const tokenResponse = z.object({ access_token: z.string().min(10), token_type: z.literal("bearer"), refresh_token: z.string().min(10).nullish(), bot_id: z.string().min(1), workspace_id: z.string().uuid(), workspace_name: z.string().max(200).nullish() });
// Notion does not report an access-token lifetime; a nominal one-year expiry is stored and a 401
// triggers a refresh (when Notion issued a refresh token) or a reconnect prompt.
export async function notionToken(clientId: string, clientSecret: string, grant: { code: string; redirectUri: string } | { refreshToken: string }, fetchImpl: typeof fetch = fetch) {
  if (!clientId || !clientSecret) throw new Error("Configure NOTION_CLIENT_ID and NOTION_CLIENT_SECRET");
  const body = "code" in grant ? { grant_type: "authorization_code", code: grant.code, redirect_uri: callback(grant.redirectUri) } : { grant_type: "refresh_token", refresh_token: grant.refreshToken };
  assertEgress("integrations", "Notion");
  const response = await fetchImpl("https://api.notion.com/v1/oauth/token", { method: "POST", redirect: "error", headers: { authorization: basic(clientId, clientSecret), "content-type": "application/json", "notion-version": notionVersion }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new NotionError(`Notion token request failed (${response.status})`, response.status);
  const result = tokenResponse.parse(await response.json());
  return { credentials: { accessToken: result.access_token, refreshToken: result.refresh_token ?? null, expiresAt: Date.now() + 365 * 86400000 } satisfies NotionCredentials, workspaceId: result.workspace_id, workspaceName: result.workspace_name || "Notion workspace" };
}
export async function revokeNotion(clientId: string, clientSecret: string, token: string, fetchImpl: typeof fetch = fetch) {
  assertEgress("integrations", "Notion");
  const response = await fetchImpl("https://api.notion.com/v1/oauth/revoke", { method: "POST", redirect: "error", headers: { authorization: basic(clientId, clientSecret), "content-type": "application/json", "notion-version": notionVersion }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new NotionError(`Notion revocation failed (${response.status})`, response.status);
}

// Page IDs from notion.so / *.notion.site links in PR text (32 hex digits, optionally dashed).
export function notionPageIds(text: string, limit = 10) {
  const ids: string[] = [];
  for (const raw of text.match(/https:\/\/[^\s<>()[\]`"']+/g) ?? []) {
    let url: URL;
    try { url = new URL(raw.replace(/[.,;:!]+$/, "")); } catch { continue; }
    if (url.username || url.password || !(url.hostname === "notion.so" || url.hostname === "www.notion.so" || url.hostname.endsWith(".notion.site"))) continue;
    const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname.replace(/\/$/, ""));
    if (!match) continue;
    const hex = match[1].replace(/-/g, "").toLowerCase(), id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids: ids.slice(0, limit), truncated: ids.length > limit };
}

const richText = z.array(z.object({ plain_text: z.string() }).passthrough());
const block = z.object({ id: z.string(), type: z.string(), has_children: z.boolean().optional() }).passthrough();
const blockPage = z.object({ results: z.array(block).max(100), has_more: z.boolean(), next_cursor: z.string().nullable() });
const pageSchema = z.object({ object: z.literal("page"), id: z.string().uuid(), url: z.string().url(), last_edited_time: z.string().datetime({ offset: true }), archived: z.boolean().optional(), in_trash: z.boolean().optional(), properties: z.record(z.object({ type: z.string() }).passthrough()) });
const text = (value: unknown) => { const parsed = richText.safeParse(value); return parsed.success ? parsed.data.map((r) => r.plain_text).join("") : ""; };
function blockLine(b: z.infer<typeof block>, depth: number) {
  const data = (b as Record<string, unknown>)[b.type] as { rich_text?: unknown; checked?: boolean; language?: string; title?: string } | undefined;
  const indent = "  ".repeat(depth), t = text(data?.rich_text);
  switch (b.type) {
    case "heading_1": return `${indent}# ${t}`;
    case "heading_2": return `${indent}## ${t}`;
    case "heading_3": return `${indent}### ${t}`;
    case "bulleted_list_item": case "toggle": return `${indent}- ${t}`;
    case "numbered_list_item": return `${indent}1. ${t}`;
    case "to_do": return `${indent}- [${data?.checked ? "x" : " "}] ${t}`;
    case "quote": case "callout": return `${indent}> ${t}`;
    case "code": return `${indent}\`\`\`${data?.language ?? ""}\n${t.replace(/```/g, "` ` `")}\n${indent}\`\`\``;
    case "divider": return `${indent}---`;
    case "child_page": return `${indent}[Subpage: ${data?.title ?? ""}]`;
    case "paragraph": return t ? indent + t : "";
    default: return t ? indent + t : "";
  }
}
export class Notion {
  constructor(private accessToken: string, private fetchImpl: typeof fetch = fetch) { if (!accessToken) throw new Error("Notion access token required"); }
  private async request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    if (!path.startsWith("/v1/")) throw new Error("Invalid Notion API path");
    assertEgress("integrations", "Notion");
    const response = await this.fetchImpl("https://api.notion.com" + path, { method: body === undefined ? "GET" : "POST", redirect: "error", headers: { authorization: "Bearer " + this.accessToken, "notion-version": notionVersion, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new NotionError(`Notion API request failed (${response.status})`, response.status);
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 2_000_000) throw new Error("Notion response exceeds 2MB retrieval limit");
    return schema.parse(JSON.parse(raw));
  }
  // Pages shared with the integration (for the admin's review of what OpenReview can read).
  async sharedPages() {
    const result = await this.request("/v1/search", z.object({ results: z.array(z.object({ object: z.string(), id: z.string(), url: z.string().optional(), properties: z.record(z.unknown()).optional() }).passthrough()).max(100) }), { filter: { property: "object", value: "page" }, page_size: 100 });
    return result.results.filter((r) => r.object === "page").map((r) => ({ id: r.id, url: r.url ?? "", title: Object.values(r.properties ?? {}).map((p) => (p as { type?: string; title?: unknown }).type === "title" ? text((p as { title?: unknown }).title) : "").join("").slice(0, 200) || "Untitled" }));
  }
  // One page as plain text: up to 1,000 top-level blocks plus one nested level (50 parents), 100KB.
  async page(id: string) {
    z.string().uuid().parse(id);
    const page = await this.request(`/v1/pages/${id}`, pageSchema);
    if (page.archived || page.in_trash) throw new Error("Notion page is archived");
    const title = Object.values(page.properties).map((p) => p.type === "title" ? text((p as { title?: unknown }).title) : "").join("").slice(0, 2000) || "Untitled";
    const lines: string[] = [];
    let bytes = 0, truncated = false, nested = 0;
    const push = (line: string) => { if (!line) return; const size = Buffer.byteLength(line, "utf8") + 1; if (bytes + size > 100000) { truncated = true; return; } bytes += size; lines.push(line); };
    const children = async (parent: string, depth: number) => {
      let cursor: string | null = null;
      for (let pageNo = 0; pageNo < (depth ? 1 : 10) && !truncated; pageNo++) {
        const result: z.infer<typeof blockPage> = await this.request(`/v1/blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`, blockPage);
        for (const b of result.results) {
          push(blockLine(b, depth));
          if (b.has_children && depth === 0 && b.type !== "child_page" && b.type !== "child_database" && nested < 50) { nested++; await children(b.id, 1); }
        }
        if (!result.has_more || !result.next_cursor) return;
        cursor = result.next_cursor;
        if (pageNo === (depth ? 0 : 9)) truncated = true;
      }
    };
    await children(id, 0);
    if (truncated) lines.push("[Content truncated at the Notion retrieval limit]");
    return { id, title, text: lines.join("\n"), revision: page.last_edited_time, url: page.url };
  }
}
