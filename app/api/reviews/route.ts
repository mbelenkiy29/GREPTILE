import { z } from "zod";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { apiIdentity, apiDenied } from "../../../src/api-auth";
import { backend } from "../../../src/server";
import { runtimeEvidenceSchema } from "../../../src/engine/types";
export async function GET(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request);
    return Response.json(
      await backend().query(api.reviews.list, {
        token,
        organizationId,
        cursor: new URL(request.url).searchParams.get("cursor") ?? undefined,
      }),
    );
  } catch (error) { const denied = apiDenied(error); if (denied) return denied;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}
export async function POST(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request, "write");
    const args = z
      .object({
        repositoryId: z.string(),
        prNumber: z.number().int().positive(),
        headSha: z.string().regex(/^[a-f0-9]{40}$/),
        runtimeEvidence: runtimeEvidenceSchema.optional(),
      })
      .parse(await request.json());
    if (args.runtimeEvidence)
      return Response.json({error:"Runtime evidence must be reported by a paired runtime worker, not supplied in a review request"},{status:400});
    const repos = await backend().query(api.repositories.list, {
      token,
      organizationId,
    });
    if (!repos.some((r) => r._id === args.repositoryId))
      return Response.json(
        { error: "Repository not accessible to this API key" },
        { status: 403 },
      );
    const reviewId = await backend().mutation(api.reviews.request, {
      token,
      ...args,
      repositoryId: args.repositoryId as Id<"repositories">,
    });
    return Response.json({ reviewId }, { status: 202 });
  } catch (error) { const denied = apiDenied(error); if (denied) return denied;
    return Response.json(
      { error: "Invalid request or authorization" },
      { status: 400 },
    );
  }
}
