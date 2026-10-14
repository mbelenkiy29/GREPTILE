import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const url = process.env.OPENREVIEW_URL,
  apiKey = process.env.OPENREVIEW_API_KEY;
if (!url || !apiKey)
  throw new Error("Configure OPENREVIEW_URL and OPENREVIEW_API_KEY");
if (
  !url.startsWith("https://") &&
  !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)
)
  throw new Error("OPENREVIEW_URL must use HTTPS");
const server = new McpServer({ name: "openreview", version: "0.1.0" });
async function call(path: string, options: RequestInit = {}) {
  const response = await fetch(new URL(path, url), {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    return {
      content: [
        {
          type: "text" as const,
          text: `OpenReview API returned HTTP ${response.status}`,
        },
      ],
      isError: true,
    };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(await response.json(), null, 2),
      },
    ],
  };
}
server.registerTool(
  "get_review",
  {
    description: "Get review lifecycle, summary, findings and model calls",
    inputSchema: { reviewId: z.string() },
  },
  ({ reviewId }) => call(`/api/reviews/${encodeURIComponent(reviewId)}`),
);
server.registerTool(
  "get_findings",
  {
    description: "Get all findings in a review",
    inputSchema: { reviewId: z.string() },
  },
  ({ reviewId }) => call(`/api/reviews/${encodeURIComponent(reviewId)}`),
);
server.registerTool(
  "get_finding",
  {
    description: "Get one finding and its evidence",
    inputSchema: { reviewId: z.string(), findingId: z.string() },
  },
  async ({ reviewId, findingId }) => {
    const response = await fetch(
      new URL(`/api/reviews/${encodeURIComponent(reviewId)}`, url),
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    if (!response.ok)
      return {
        content: [{ type: "text", text: "Review unavailable" }],
        isError: true,
      };
    const data = await response.json();
    const finding = data.findings.find(
      (f: { _id: string }) => f._id === findingId,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(finding ?? { error: "Finding not found" }),
        },
      ],
    };
  },
);
server.registerTool(
  "get_repository_context",
  {
    description: "Read repository graph, knowledge and optional source file",
    inputSchema: { repositoryId: z.string(), path: z.string().optional() },
  },
  ({ repositoryId, path }) =>
    call(
      `/api/context?repositoryId=${encodeURIComponent(repositoryId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
    ),
);
server.registerTool(
  "search_codebase",
  {
    description: "Search indexed paths and symbols",
    inputSchema: { repositoryId: z.string(), query: z.string().max(100) },
  },
  ({ repositoryId, query }) =>
    call(
      `/api/context?repositoryId=${encodeURIComponent(repositoryId)}&query=${encodeURIComponent(query)}`,
    ),
);
server.registerTool(
  "get_related_files",
  {
    description: "Get graph relationships and context for a file",
    inputSchema: { repositoryId: z.string(), path: z.string() },
  },
  ({ repositoryId, path }) =>
    call(
      `/api/context?repositoryId=${encodeURIComponent(repositoryId)}&path=${encodeURIComponent(path)}`,
    ),
);
server.registerTool(
  "get_custom_rules",
  {
    description: "Get rules applying to a repository",
    inputSchema: { repositoryId: z.string() },
  },
  ({ repositoryId }) =>
    call(`/api/context?repositoryId=${encodeURIComponent(repositoryId)}`),
);
server.registerTool(
  "mark_finding_resolved",
  {
    description: "Mark a finding resolved with developer evidence",
    inputSchema: { findingId: z.string(), comment: z.string().max(5000) },
  },
  ({ findingId, comment }) =>
    call(`/api/findings/${encodeURIComponent(findingId)}/feedback`, {
      method: "POST",
      body: JSON.stringify({ value: "resolved", comment }),
    }),
);
await server.connect(new StdioServerTransport());
