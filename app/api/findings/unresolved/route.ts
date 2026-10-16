import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiIdentity, apiFailure } from "../../../../src/api-auth";
import { backendFailure, convexId } from "../../../../src/public-api";
import { backend } from "../../../../src/server";

// Open findings on the key owner's own open pull requests, optionally in one repository.
export async function GET(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request);
    const repositoryId = new URL(request.url).searchParams.get("repositoryId");
    const id = repositoryId ? convexId.parse(repositoryId) as Id<"repositories"> : undefined;
    try { return Response.json(await backend().query(api.mcpApi.unresolvedForUser, { token, organizationId, ...(id ? { repositoryId: id } : {}) })); }
    catch (error) { return backendFailure(error) ?? Response.json({ error: "Repository not accessible to this API key" }, { status: 404 }); }
  } catch (error) { return apiFailure(error, { status: 400, error: "Invalid request" }); }
}
