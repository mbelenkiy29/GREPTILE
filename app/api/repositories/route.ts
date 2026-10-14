import { api } from "../../../convex/_generated/api";
import { apiIdentity } from "../../../src/api-auth";
import { backend } from "../../../src/server";
export async function GET(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request);
    return Response.json(
      await backend().query(api.repositories.list, { token, organizationId }),
    );
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}
