import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiIdentity, apiFailure } from "../../../../src/api-auth";
import { backendFailure, convexId } from "../../../../src/public-api";
import { backend } from "../../../../src/server";

// Latest review of a pull request: status, verdict, whether it covers the current head, open findings.
const params = z.object({ repositoryId: convexId, prNumber: z.coerce.number().int().positive() });
export async function GET(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request);
    const q = params.parse(Object.fromEntries(new URL(request.url).searchParams));
    try { return Response.json(await backend().query(api.mcpApi.prStatus, { token, organizationId, repositoryId: q.repositoryId as Id<"repositories">, prNumber: q.prNumber })); }
    catch (error) { return backendFailure(error) ?? Response.json({ error: "Repository not accessible to this API key" }, { status: 404 }); }
  } catch (error) { return apiFailure(error, { status: 400, error: "Invalid request" }); }
}
