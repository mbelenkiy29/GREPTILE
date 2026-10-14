import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiFailure, apiIdentity } from "../../../../src/api-auth";
import { backend } from "../../../../src/server";
import { backendFailure, convexId, queryResult } from "../../../../src/public-api";

// Fetch a query's result later (for answers still running when POST /api/query returned 202).
export async function GET(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const { token, organizationId } = await apiIdentity(request, "read");
    const messageId = convexId.parse((await params).messageId) as Id<"chatMessages">;
    try {
      const thread = await backend().query(api.chat.threadOf, { token, messageId, organizationId });
      const progress = await backend().query(api.chat.progress, { token, messageId });
      return Response.json(queryResult({ threadId: thread, messageId }, progress), { headers: { "cache-control": "no-store" } });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "Query unavailable" }, { status: 404 }); }
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
