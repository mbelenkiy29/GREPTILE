import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { apiIdentity } from "../../../../../src/api-auth";
import { backend } from "../../../../../src/server";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { token, organizationId } = await apiIdentity(request),
      { id } = await params;
    const input = z
      .object({
        value: z.enum([
          "useful",
          "not_useful",
          "resolved",
          "wont_fix",
          "false_positive",
        ]),
        comment: z.string().max(5000).default(""),
      })
      .parse(await request.json());
    const finding = await backend().query(api.findings.get, {
      token,
      findingId: id as Id<"findings">,
    });
    if (finding.organizationId !== organizationId)
      return Response.json(
        { error: "Finding not accessible to this API key" },
        { status: 403 },
      );
    await backend().mutation(api.dashboard.feedback, {
      token,
      findingId: id as Id<"findings">,
      ...input,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: "Invalid request or authorization" },
      { status: 400 },
    );
  }
}
