import { test } from "node:test";
import assert from "node:assert/strict";
import { Notion, NotionError, notionAuthorization, notionPageIds, notionToken, revokeNotion } from "../src/notion";

const page = "1f2e3d4c5b6a47988796a5b4c3d2e1f0", dashed = "1f2e3d4c-5b6a-4798-8796-a5b4c3d2e1f0";
type Call = { url: string; init?: RequestInit };
function fake(routes: (url: URL, init?: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init }); return routes(new URL(String(input)), init) ?? new Response("unexpected", { status: 500 }); }) as typeof fetch;
  return { calls, impl };
}

test("Notion OAuth: user-owned authorize URL, Basic-auth token exchange and refresh, revocation", async () => {
  const url = new URL(notionAuthorization("client-1", "https://review.example.com/api/integrations/notion/callback", "s".repeat(43)));
  assert.equal(url.origin + url.pathname, "https://api.notion.com/v1/oauth/authorize");
  assert.equal(url.searchParams.get("owner"), "user");assert.equal(url.searchParams.get("response_type"), "code");
  assert.throws(() => notionAuthorization("client-1", "http://evil.example/cb", "s".repeat(43)), /HTTPS/);
  const grant = { access_token: "ntn_access_token_1", token_type: "bearer", refresh_token: "ntn_refresh_token_1", bot_id: "bot", workspace_id: "8f1e2d3c-4b5a-4697-8a9b-0c1d2e3f4a5b", workspace_name: "Acme" };
  const net = fake((u) => u.pathname === "/v1/oauth/token" ? Response.json(grant) : u.pathname === "/v1/oauth/revoke" ? Response.json({}) : undefined);
  const result = await notionToken("client-1", "secret-1", { code: "c0de", redirectUri: "https://review.example.com/api/integrations/notion/callback" }, net.impl);
  assert.deepEqual({ ...result.credentials, expiresAt: 0 }, { accessToken: "ntn_access_token_1", refreshToken: "ntn_refresh_token_1", expiresAt: 0 });
  assert.equal(result.workspaceId, grant.workspace_id);
  const headers = new Headers(net.calls[0].init?.headers);
  assert.equal(headers.get("authorization"), "Basic " + Buffer.from("client-1:secret-1").toString("base64"));
  assert.deepEqual(JSON.parse(String(net.calls[0].init?.body)), { grant_type: "authorization_code", code: "c0de", redirect_uri: "https://review.example.com/api/integrations/notion/callback" });
  await notionToken("client-1", "secret-1", { refreshToken: "ntn_refresh_token_1" }, net.impl);
  assert.deepEqual(JSON.parse(String(net.calls[1].init?.body)), { grant_type: "refresh_token", refresh_token: "ntn_refresh_token_1" });
  await revokeNotion("client-1", "secret-1", "ntn_access_token_1", net.impl);
  assert.equal(net.calls[2].url, "https://api.notion.com/v1/oauth/revoke");
  assert.deepEqual(JSON.parse(String(net.calls[2].init?.body)), { token: "ntn_access_token_1" });
  const noRefresh = fake(() => Response.json({ ...grant, refresh_token: null }));
  assert.equal((await notionToken("client-1", "secret-1", { code: "c", redirectUri: "https://r.example/cb" }, noRefresh.impl)).credentials.refreshToken, null);
  await assert.rejects(notionToken("client-1", "secret-1", { code: "c", redirectUri: "https://r.example/cb" }, fake(() => Response.json({ error: "invalid_grant" }, { status: 400 })).impl), (e: unknown) => e instanceof NotionError && e.status === 400);
  await assert.rejects(notionToken("", "", { code: "c", redirectUri: "https://r.example/cb" }), /Configure NOTION_CLIENT_ID/);
});

test("only Notion page links in PR text are recognised, deduplicated and capped", () => {
  const text = [`See https://www.notion.so/acme/Checkout-spec-${page}?pvs=4.`, `again https://notion.so/${dashed}`, `public https://acme.notion.site/Plan-${"a".repeat(32)}`, `https://evil.example/${"b".repeat(32)}`, `https://user:pw@www.notion.so/${"c".repeat(32)}`, "https://www.notion.so/no-id-here"].join("\n");
  assert.deepEqual(notionPageIds(text), { ids: [dashed, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], truncated: false });
  const many = Array.from({ length: 12 }, (_, i) => `https://www.notion.so/${i.toString(16).padStart(32, "0")}`).join(" ");
  assert.deepEqual([notionPageIds(many).ids.length, notionPageIds(many).truncated], [10, true]);
});

test("pages are read as bounded plain text; archived pages and API failures are refused", async () => {
  const blocks = (results: unknown[], next: string | null = null) => Response.json({ results, has_more: Boolean(next), next_cursor: next });
  const rt = (t: string) => [{ plain_text: t }];
  const net = fake((u) => {
    if (u.pathname === `/v1/pages/${dashed}`) return Response.json({ object: "page", id: dashed, url: `https://www.notion.so/Spec-${page}`, last_edited_time: "2026-10-01T10:00:00.000Z", archived: false, properties: { Name: { type: "title", title: rt("Checkout spec") } } });
    if (u.pathname === `/v1/blocks/${dashed}/children` && !u.searchParams.get("start_cursor")) return blocks([{ id: "b1", type: "heading_1", heading_1: { rich_text: rt("Totals") } }, { id: "b2", type: "bulleted_list_item", has_children: true, bulleted_list_item: { rich_text: rt("Amounts are integer cents") } }, { id: "b3", type: "code", code: { language: "ts", rich_text: rt("total(cents)") } }], "cursor-2");
    if (u.pathname === `/v1/blocks/${dashed}/children`) return blocks([{ id: "b4", type: "to_do", to_do: { checked: true, rich_text: rt("Round once") } }, { id: "b5", type: "unsupported", unsupported: {} }]);
    if (u.pathname === "/v1/blocks/b2/children") return blocks([{ id: "c1", type: "paragraph", paragraph: { rich_text: rt("Never floats") } }]);
    return undefined;
  });
  const result = await new Notion("ntn_access", net.impl).page(dashed);
  assert.equal(result.title, "Checkout spec");
  assert.equal(result.revision, "2026-10-01T10:00:00.000Z");
  assert.equal(result.text, "# Totals\n- Amounts are integer cents\n  Never floats\n```ts\ntotal(cents)\n```\n- [x] Round once");
  assert.equal(new Headers(net.calls[0].init?.headers).get("notion-version"), "2022-06-28");
  const archived = fake((u) => u.pathname.startsWith("/v1/pages/") ? Response.json({ object: "page", id: dashed, url: "https://www.notion.so/x", last_edited_time: "2026-10-01T10:00:00.000Z", archived: true, properties: {} }) : undefined);
  await assert.rejects(new Notion("ntn_access", archived.impl).page(dashed), /archived/);
  await assert.rejects(new Notion("ntn_access", fake(() => Response.json({}, { status: 401 })).impl).page(dashed), (e: unknown) => e instanceof NotionError && e.status === 401);
  await assert.rejects(new Notion("ntn_access", net.impl).page("not-a-uuid"));
  // Oversized pages are truncated at 100KB with a visible marker.
  const big = fake((u) => u.pathname.startsWith("/v1/pages/") ? Response.json({ object: "page", id: dashed, url: "https://www.notion.so/x", last_edited_time: "2026-10-01T10:00:00.000Z", properties: {} }) : blocks(Array.from({ length: 100 }, (_, i) => ({ id: "p" + i, type: "paragraph", paragraph: { rich_text: rt("x".repeat(1500)) } })), "more"));
  const truncated = await new Notion("ntn_access", big.impl).page(dashed);
  assert.ok(Buffer.byteLength(truncated.text) <= 100_100);
  assert.match(truncated.text, /\[Content truncated at the Notion retrieval limit\]$/);
});
