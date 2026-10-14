import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// OpenReview MCP tools, shared by the stdio server (src/mcp.ts, calls the REST API over HTTPS)
// and the remote Streamable HTTP endpoint (app/api/mcp, dispatches to the same route handlers
// in-process). Every tool goes through the public API, so API-key scopes and workspace
// isolation apply identically.
export type ApiCall = (path: string, init?: { method?: "GET" | "POST"; body?: unknown }) => Promise<{ status: number; body: unknown }>;
type Text = { type: "text"; text: string };
const text = (value: string): Text => ({ type: "text", text: value });
function result(response: { status: number; body: unknown }) {
  if (response.status >= 400) {
    const error = (response.body as { error?: unknown } | null)?.error;
    return { content: [text(`OpenReview API returned HTTP ${response.status}${typeof error === "string" ? `: ${error}` : ""}`)], isError: true };
  }
  return { content: [text(JSON.stringify(response.body, null, 2))] };
}
const id = z.string().regex(/^[A-Za-z0-9]{20,64}$/, "Use an OpenReview ID");
const q = (value: string) => encodeURIComponent(value);
export const mcpToolNames = ["get_review", "get_findings", "get_finding", "get_repository_context", "search_codebase", "get_related_files", "get_custom_rules", "mark_finding_resolved", "list_repositories", "ask_codebase", "search_code"] as const;

export function registerOpenReviewTools(server: McpServer, call: ApiCall) {
  server.registerTool("get_review", { description: "Get review lifecycle, summary, findings and model calls", inputSchema: { reviewId: id } }, async ({ reviewId }) => result(await call(`/api/reviews/${q(reviewId)}`)));
  server.registerTool("get_findings", { description: "Get all findings in a review", inputSchema: { reviewId: id } }, async ({ reviewId }) => {
    const response = await call(`/api/reviews/${q(reviewId)}`);
    return response.status >= 400 ? result(response) : result({ status: 200, body: (response.body as { findings?: unknown[] }).findings ?? [] });
  });
  server.registerTool("get_finding", { description: "Get one finding and its evidence", inputSchema: { reviewId: id, findingId: id } }, async ({ reviewId, findingId }) => {
    const response = await call(`/api/reviews/${q(reviewId)}`);
    if (response.status >= 400) return result(response);
    const finding = ((response.body as { findings?: { _id: string }[] }).findings ?? []).find((f) => f._id === findingId);
    return finding ? result({ status: 200, body: finding }) : { content: [text("Finding not found in that review")], isError: true };
  });
  server.registerTool("get_repository_context", { description: "Read repository graph, knowledge and optional source file", inputSchema: { repositoryId: id, path: z.string().max(500).optional() } }, async ({ repositoryId, path }) => result(await call(`/api/context?repositoryId=${q(repositoryId)}${path ? `&path=${q(path)}` : ""}`)));
  server.registerTool("search_codebase", { description: "Search indexed paths and symbols by name", inputSchema: { repositoryId: id, query: z.string().min(1).max(100) } }, async ({ repositoryId, query }) => result(await call(`/api/context?repositoryId=${q(repositoryId)}&query=${q(query)}`)));
  server.registerTool("get_related_files", { description: "Get graph relationships and context for a file", inputSchema: { repositoryId: id, path: z.string().max(500) } }, async ({ repositoryId, path }) => result(await call(`/api/context?repositoryId=${q(repositoryId)}&path=${q(path)}`)));
  server.registerTool("get_custom_rules", { description: "Get rules applying to a repository", inputSchema: { repositoryId: id } }, async ({ repositoryId }) => result(await call(`/api/context?repositoryId=${q(repositoryId)}`)));
  server.registerTool("mark_finding_resolved", { description: "Mark a finding resolved with developer evidence (needs a write-scoped key)", inputSchema: { findingId: id, comment: z.string().max(5000) } }, async ({ findingId, comment }) => result(await call(`/api/findings/${q(findingId)}/feedback`, { method: "POST", body: { value: "resolved", comment } })));
  server.registerTool("list_repositories", { description: "List repositories visible to this API key, with index status", inputSchema: {} }, async () => result(await call("/api/repositories")));
  server.registerTool("ask_codebase", { description: "Ask a question about up to five indexed repositories. OpenReview investigates with read-only code tools and answers only with sources that exactly match lines at the indexed revision. Pass threadId for a follow-up.", inputSchema: { question: z.string().min(2).max(4000), repositoryIds: z.array(id).min(1).max(5), threadId: id.optional() } }, async (input) => result(await call("/api/query", { method: "POST", body: input })));
  server.registerTool("search_code", { description: "Hybrid semantic and full-text code search over indexed repositories; returns ranked snippets with paths and lines", inputSchema: { query: z.string().min(2).max(200), repositoryIds: z.array(id).min(1).max(10).optional(), limit: z.number().int().min(1).max(50).optional() } }, async (input) => result(await call("/api/search", { method: "POST", body: input })));
}
