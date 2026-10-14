import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiIdentity, apiDenied } from "../../../../src/api-auth";
import { backend } from "../../../../src/server";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { token, organizationId } = await apiIdentity(request);
    const { id } = await params;
    const result = await backend().query(api.reviews.detail, {
      token,
      reviewId: id as Id<"reviews">,
      historyCursor: new URL(request.url).searchParams.get("historyCursor") ?? undefined,
    });
    if (result.review.organizationId !== organizationId)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    return Response.json(result);
  } catch (error) { const denied = apiDenied(error); if (denied) return denied;
    return Response.json(
      { error: "Review unavailable or unauthorized" },
      { status: 404 },
    );
  }
}
