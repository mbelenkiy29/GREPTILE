import { productionApiDeps } from "@/lib/api/next";
import { handleMcpRequest, mcpMethodNotAllowed } from "@/lib/mcp/server";

/** OpenReview's remote MCP server (Streamable HTTP, stateless; R3.2). */
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleMcpRequest(productionApiDeps(), req);
}

export function GET(): Response {
  return mcpMethodNotAllowed();
}

export function DELETE(): Response {
  return mcpMethodNotAllowed();
}
