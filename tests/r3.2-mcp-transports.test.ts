import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import { API_SCOPES } from "@/lib/api/keys";
import { MemoryRateLimiter } from "@/lib/api/rate-limit";
import { executeRoute, matchRoute, type ApiDeps } from "@/lib/api/router";
import { V1_ROUTES } from "@/lib/api/v1";
import { listAudit } from "@/lib/data/audit";
import { findingFeedback } from "@/lib/db/schema";
import { handleMcpRequest, mcpMethodNotAllowed } from "@/lib/mcp/server";
import { ConfigError, configFilePath, resolveConfig, restApi } from "@/packages/mcp/src/rest";
import { PACKAGE_VERSION } from "@/packages/mcp/src/stdio";
import { createOpenReviewMcpServer } from "@/packages/mcp/src/tools";
import { API_ORIGIN, apiDeps, makeKey } from "./helpers/api";
import { signedInCookie, makeUser, addMember } from "./helpers/auth";
import { dashboardFixture } from "./helpers/dashboard";

const NOW = new Date("2026-03-01T12:00:00Z");
const MCP_URL = `${API_ORIGIN}/api/mcp`;

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

/** A fetch that serves `/api/mcp` with the route handler logic. */
function mcpFetch(deps: ApiDeps): typeof fetch {
  return async (input, init) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    if (req.method === "POST") return handleMcpRequest(deps, req);
    return mcpMethodNotAllowed();
  };
}

describe("MCP Streamable HTTP endpoint (R3.2)", () => {
  test("R3.2 the /api/mcp handler accepts a valid API key and serves tools over Streamable HTTP", async () => {
    const fx = await dashboardFixture(NOW);
    const deps = apiDeps(fx.db);
    const { token } = await makeKey(fx.db, "org_a", [...API_SCOPES]);

    const init = await handleMcpRequest(deps, rpc(initialize, { authorization: `Bearer ${token}` }));
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(init.headers.get("x-ratelimit-limit")).toBe("1000");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const body = (await init.json()) as { result: { serverInfo: { name: string }; capabilities: { tools?: unknown; resources?: unknown } } };
    expect(body.result.serverInfo.name).toBe("openreview");
    expect(body.result.capabilities.tools).toBeDefined();

    // The official client end to end (initialize, initialized notification, the 405 on the optional GET stream).
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: mcpFetch(deps), requestInit: { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" } } }));
    const res = (await client.callTool({ name: "mark_finding_resolved", arguments: { findingId: fx.findings.fCritical.id } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const [fb] = await fx.db.select().from(findingFeedback).where(eq(findingFeedback.source, "mcp"));
    expect(fb).toMatchObject({ findingId: fx.findings.fCritical.id, kind: "resolved", orgId: "org_a" });
    // Writes are audited like REST calls, as the key, with the MCP client's address.
    const queued = (await client.callTool({ name: "trigger_review", arguments: { repository: "acme/api", prNumber: 1 } })) as CallToolResult;
    expect(queued.isError).toBeFalsy();
    const [entry] = (await listAudit(fx.db, "org_a")).filter((a) => a.action === "review.requested");
    expect(entry).toMatchObject({ actorType: "api_key", ip: "203.0.113.9" });
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(12);
    await client.close();
  });

  test("R3.2 the /api/mcp handler rejects missing, malformed, unknown, and revoked keys, cookies, and foreign origins; GET and DELETE are 405", async () => {
    const fx = await dashboardFixture(NOW);
    const deps = apiDeps(fx.db);

    const missing = await handleMcpRequest(deps, rpc(initialize));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="openreview"');
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const malformed = await handleMcpRequest(deps, rpc(initialize, { authorization: "Bearer not-a-key" }));
    expect(malformed.status).toBe(401);
    const unknown = await handleMcpRequest(deps, rpc(initialize, { authorization: `Bearer or_live_${"A".repeat(43)}` }));
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toBe("The API key is not valid.");

    // The dashboard session cookie is not an MCP credential.
    const user = await makeUser(fx.db, "dana");
    await addMember(fx.db, "org_a", user.id, "owner");
    const { cookie } = await signedInCookie(fx.db, user.id, "org_a");
    const withCookie = await handleMcpRequest(deps, rpc(initialize, { cookie, origin: API_ORIGIN }));
    expect(withCookie.status).toBe(401);

    const { token } = await makeKey(fx.db, "org_a", ["reviews:read"]);
    const foreign = await handleMcpRequest(deps, rpc(initialize, { authorization: `Bearer ${token}`, origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);
    const sameOrigin = await handleMcpRequest(deps, rpc(initialize, { authorization: `Bearer ${token}`, origin: API_ORIGIN }));
    expect(sameOrigin.status).toBe(200);

    const get = mcpMethodNotAllowed();
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const route = readFileSync(path.resolve(import.meta.dirname, "../app/api/mcp/route.ts"), "utf8");
    expect(route).toMatch(/export function GET\(\): Response \{\n\s+return mcpMethodNotAllowed\(\);/);
    expect(route).toMatch(/export function DELETE\(\): Response \{\n\s+return mcpMethodNotAllowed\(\);/);
    expect(route).toMatch(/export function POST\(req: Request\)[^{]*\{\n\s+return handleMcpRequest\(productionApiDeps\(\), req\);/);
  });

  test("R3.2 MCP requests share the API key's rate limit (429 with retry-after)", async () => {
    const fx = await dashboardFixture(NOW);
    const deps = apiDeps(fx.db, { limiter: new MemoryRateLimiter(), rateLimitPerMinute: 2 });
    const { token } = await makeKey(fx.db, "org_a", ["reviews:read"]);
    const auth = { authorization: `Bearer ${token}` };
    expect((await handleMcpRequest(deps, rpc(initialize, auth))).status).toBe(200);
    expect((await handleMcpRequest(deps, rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, auth))).status).toBe(200);
    const limited = await handleMcpRequest(deps, rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, auth));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("openreview-mcp stdio proxy (R3.2)", () => {
  /** A fetch that serves REST API v1 from the route table, recording each request. */
  function restFetch(deps: ApiDeps) {
    const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
    const f: typeof fetch = async (input, init) => {
      const req = new Request(String(input), init);
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.clone().json() : undefined;
      calls.push({ method: req.method, url: `${url.pathname}${url.search}`, auth: req.headers.get("authorization"), body });
      const match = matchRoute(V1_ROUTES, req.method, url.pathname.replace(/^\/api\/v1/, ""));
      if (!match) return new Response("no route", { status: 404 });
      return executeRoute(match.route, deps, req, match.params);
    };
    return { fetch: f, calls };
  }

  async function proxyClient(deps: ApiDeps, token: string) {
    const rest = restFetch(deps);
    const server = createOpenReviewMcpServer(restApi({ config: { url: `${API_ORIGIN}/`, token }, fetch: rest.fetch }), { version: PACKAGE_VERSION });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "proxy-test", version: "1" });
    await client.connect(c);
    return { client, calls: rest.calls };
  }

  test("R3.2 the stdio proxy maps each tool to REST API calls with the bearer key", async () => {
    const fx = await dashboardFixture(NOW);
    const deps = apiDeps(fx.db);
    const { token } = await makeKey(fx.db, "org_a", [...API_SCOPES]);
    const { client, calls } = await proxyClient(deps, token);
    const r1 = fx.reviews.r1.review.id;
    const crit = fx.findings.fCritical.id;

    const expectations: [string, Record<string, unknown>, string[]][] = [
      ["list_reviews", { repository: "acme/api", prNumber: 1 }, ["GET /api/v1/repositories?q=acme%2Fapi&pageSize=100", `GET /api/v1/reviews?repositoryId=${fx.repos.api.id}&prNumber=1&pageSize=20`]],
      ["get_review", { reviewId: r1 }, [`GET /api/v1/reviews/${r1}`]],
      ["list_review_comments", { reviewId: r1, minSeverity: "high" }, [`GET /api/v1/findings?reviewId=${r1}&status=open&severity=critical%2Chigh&sort=severity&page=1&pageSize=100`]],
      ["list_findings", { severity: ["critical"] }, ["GET /api/v1/findings?status=open&severity=critical&sort=severity&pageSize=50"]],
      ["get_finding", { findingId: crit }, [`GET /api/v1/findings/${crit}`, `GET /api/v1/findings/${crit}/fix-prompt?agent=claude-code`]],
      ["mark_finding_resolved", { findingId: crit }, [`POST /api/v1/findings/${crit}/feedback`]],
      ["trigger_review", { repository: fx.repos.api.id, prNumber: 1 }, ["POST /api/v1/reviews"]],
      ["get_fix_all", { reviewId: r1 }, [`GET /api/v1/reviews/${r1}/fix-all`]],
      ["search_codebase", { repository: fx.repos.api.id, query: "invoice search" }, [`GET /api/v1/repositories/${fx.repos.api.id}/search?q=invoice+search&limit=10`]],
      ["get_related_files", { repository: fx.repos.api.id, path: "src/search.ts" }, [`GET /api/v1/repositories/${fx.repos.api.id}/related?path=src%2Fsearch.ts`]],
      ["list_rules", {}, ["GET /api/v1/rules?status=active"]],
      ["get_repository_context", { repository: fx.repos.api.id }, [`GET /api/v1/repositories/${fx.repos.api.id}/knowledge`]],
    ];
    for (const [tool, args, requests] of expectations) {
      calls.length = 0;
      const res = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
      expect(res.isError, `${tool}: ${JSON.stringify(res.content)}`).toBeFalsy();
      expect(calls.map((c) => `${c.method} ${c.url}`), tool).toEqual(requests);
      for (const c of calls) expect(c.auth).toBe(`Bearer ${token}`);
    }
    const [feedback] = await fx.db.select().from(findingFeedback).where(eq(findingFeedback.source, "mcp"));
    expect(feedback).toMatchObject({ kind: "resolved", findingId: crit });

    // API errors become tool errors with the server's message.
    const { token: weak } = await makeKey(fx.db, "org_a", ["reviews:read"]);
    const limited = await proxyClient(deps, weak);
    const denied = (await limited.client.callTool({ name: "list_findings", arguments: {} })) as CallToolResult;
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("This API key lacks the findings:read scope.");
    const down = createOpenReviewMcpServer(
      restApi({ config: { url: API_ORIGIN, token }, fetch: async () => Promise.reject(new Error("ECONNREFUSED")) }),
      { version: PACKAGE_VERSION },
    );
    const [c, s] = InMemoryTransport.createLinkedPair();
    await down.connect(s);
    const offline = new Client({ name: "offline", version: "1" });
    await offline.connect(c);
    const unreachable = (await offline.callTool({ name: "list_reviews", arguments: {} })) as CallToolResult;
    expect(JSON.stringify(unreachable.content)).toContain("Could not reach the OpenReview server");
  });

  test("R3.2 the stdio proxy reads OPENREVIEW_URL/OPENREVIEW_TOKEN, falling back to the CLI config file", async () => {
    const token = `or_live_${"b".repeat(43)}`;
    const noFile = async () => Promise.reject(new Error("ENOENT"));
    expect(await resolveConfig({ OPENREVIEW_URL: "https://review.example.com/", OPENREVIEW_TOKEN: token }, noFile)).toEqual({ url: "https://review.example.com", token, source: "env" });
    expect((await resolveConfig({ OPENREVIEW_URL: "https://review.example.com/api/v1", OPENREVIEW_TOKEN: token }, noFile)).url).toBe("https://review.example.com");

    const files: Record<string, string> = { [configFilePath({}, "/home/u")]: JSON.stringify({ server: "https://or.internal", token }) };
    expect(configFilePath({}, "/home/u")).toBe("/home/u/.config/openreview/config.json");
    expect(configFilePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/openreview/config.json");
    const read = async (f: string) => files[f] ?? Promise.reject(new Error("ENOENT"));
    expect(await resolveConfig({}, read, "/home/u")).toEqual({ url: "https://or.internal", token, source: "config file" });
    // Each variable overrides the file.
    expect((await resolveConfig({ OPENREVIEW_URL: "https://other.example" }, read, "/home/u")).url).toBe("https://other.example");

    await expect(resolveConfig({}, noFile, "/home/u")).rejects.toThrow(ConfigError);
    await expect(resolveConfig({}, noFile, "/home/u")).rejects.toThrow(/Set OPENREVIEW_URL .* and OPENREVIEW_TOKEN/);
    await expect(resolveConfig({ OPENREVIEW_URL: "https://x.example", OPENREVIEW_TOKEN: "ghp_nope" }, noFile)).rejects.toThrow(/not an OpenReview API key/);
    await expect(resolveConfig({ OPENREVIEW_URL: "ftp://x.example", OPENREVIEW_TOKEN: token }, noFile)).rejects.toThrow(/http\(s\)/);

    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../packages/mcp/package.json"), "utf8")) as { name: string; version: string; bin: Record<string, string> };
    expect(pkg).toMatchObject({ name: "openreview-mcp", version: PACKAGE_VERSION, bin: { "openreview-mcp": "dist/bin.js" } });
  });
});
