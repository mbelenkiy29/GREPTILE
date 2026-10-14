import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { apiIdentity, apiDenied } from "../../../src/api-auth";
import { backend } from "../../../src/server";
export async function GET(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request),
      url = new URL(request.url);
    const repositoryId = url.searchParams.get("repositoryId");
    if (!repositoryId)
      return Response.json({ error: "repositoryId required" }, { status: 400 });
    const repos = await backend().query(api.repositories.list, {
      token,
      organizationId,
    });
    if (!repos.some((r) => r._id === repositoryId))
      return Response.json({ error: "Forbidden" }, { status: 403 });
    const query = url.searchParams.get("query");
    if (query)
      return Response.json(
        await backend().query(api.context.search, {
          token,
          repositoryId: repositoryId as Id<"repositories">,
          query,
        }),
      );
    const data = await backend().query(api.agentContext.get, {
      token,
      repositoryId: repositoryId as Id<"repositories">,
      path: url.searchParams.get("path") ?? undefined,
    });
    const content = data.file?.url
      ? await fetch(data.file.url, { signal: AbortSignal.timeout(10000) }).then(
          (r) => r.text(),
        )
      : undefined;
    return Response.json({
      ...data,
      file: data.file
        ? { path: data.file.path, sha: data.file.sha, content }
        : null,
    });
  } catch (error) { const denied = apiDenied(error); if (denied) return denied;
    return Response.json(
      { error: "Context unavailable or unauthorized" },
      { status: 400 },
    );
  }
}
