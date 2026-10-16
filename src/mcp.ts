import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenReviewTools } from "./mcp-tools";

// Local stdio MCP server: the shared OpenReview tools, calling the REST API with an API key.
const url = process.env.OPENREVIEW_URL,
  apiKey = process.env.OPENREVIEW_API_KEY;
if (!url || !apiKey)
  throw new Error("Configure OPENREVIEW_URL and OPENREVIEW_API_KEY");
if (
  !url.startsWith("https://") &&
  !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)
)
  throw new Error("OPENREVIEW_URL must use HTTPS");
const server = new McpServer({ name: "openreview", version: "0.3.0" });
registerOpenReviewTools(server, async (path, init = {}) => {
  const response = await fetch(new URL(path, url), {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(path === "/api/query" ? 300_000 : 30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
});
await server.connect(new StdioServerTransport());
