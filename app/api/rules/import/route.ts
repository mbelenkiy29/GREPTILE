import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiIdentity, apiFailure } from "../../../../src/api-auth";
import { backendFailure, convexId } from "../../../../src/public-api";
import { backend } from "../../../../src/server";

// Imports candidate rules (from AI rule files) as suggestions that a workspace admin approves.
// Admin scope; the server guards every candidate again.
const importRequest = z.object({
  repositoryId: convexId.optional(),
  rules: z.array(z.object({
    title: z.string().trim().min(3).max(120),
    instructions: z.string().trim().min(20).max(2000),
    globs: z.array(z.string().max(200)).max(20).default([]),
    source: z.object({ path: z.string().min(1).max(200), line: z.number().int().positive() }),
  }).strict()).min(1).max(50),
}).strict();
export async function POST(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request, "admin");
    const body = importRequest.parse(await request.json());
    try {
      const result = await backend().mutation(api.ruleAssistant.importRules, { token, organizationId, ...(body.repositoryId ? { repositoryId: body.repositoryId as Id<"repositories"> } : {}), rules: body.rules });
      return Response.json({ suggested: result.suggested, rejected: result.rejected }, { status: 201 });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "Rules could not be imported; check the repository and your admin access" }, { status: 400 }); }
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
