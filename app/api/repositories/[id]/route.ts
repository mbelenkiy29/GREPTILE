import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiFailure, apiIdentity } from "../../../../src/api-auth";
import { backend } from "../../../../src/server";
import { backendFailure, convexId } from "../../../../src/public-api";

// Index status of one repository in the key's workspace.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { token, organizationId } = await apiIdentity(request, "read");
    const repositoryId = convexId.parse((await params).id) as Id<"repositories">;
    try {
      return Response.json(await backend().query(api.repositories.status, { token, organizationId, repositoryId }), { headers: { "cache-control": "no-store" } });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "Repository unavailable" }, { status: 404 }); }
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
