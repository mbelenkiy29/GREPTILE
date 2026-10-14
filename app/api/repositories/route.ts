import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { apiIdentity, apiDenied, apiFailure } from "../../../src/api-auth";
import { backendFailure, enableRequest } from "../../../src/public-api";
import { backend } from "../../../src/server";
export async function GET(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request);
    return Response.json(
      await backend().query(api.repositories.list, { token, organizationId }),
    );
  } catch (error) { const denied = apiDenied(error); if (denied) return denied;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}
// Enable an installed repository and start indexing it (re-indexes an enabled one). Needs write.
export async function POST(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request, "write");
    const repositoryId = enableRequest.parse(await request.json()).repositoryId as Id<"repositories">;
    try {
      const status = await backend().query(api.repositories.status, { token, organizationId, repositoryId });
      if (status.enabled) await backend().mutation(api.repositories.reindex, { token, repositoryId });
      else await backend().mutation(api.repositories.configure, { token, repositoryId, enabled: true });
      return Response.json(await backend().query(api.repositories.status, { token, organizationId, repositoryId }), { status: 202 });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "Repository could not be enabled; check the provider installation" }, { status: 400 }); }
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
