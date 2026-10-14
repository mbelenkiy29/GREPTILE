import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { apiFailure, apiIdentity } from "../../../src/api-auth";
import { backend } from "../../../src/server";
import { backendFailure, searchRequest } from "../../../src/public-api";

// Hybrid (full-text + semantic) code search returning ranked snippets at the indexed revision.
export async function POST(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request, "read");
    const body = searchRequest.parse(await request.json());
    try {
      const results = await backend().action(api.searchJobs.hybrid, { token, organizationId, query: body.query, ...(body.repositoryIds ? { repositoryIds: body.repositoryIds as Id<"repositories">[] } : {}), ...(body.limit ? { limit: body.limit } : {}) });
      return Response.json({ results }, { headers: { "cache-control": "no-store" } });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "Search rejected" }, { status: 400 }); }
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
