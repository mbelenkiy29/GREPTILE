import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiIdentity, apiFailure } from "../../../../src/api-auth";
import { backendFailure, convexId } from "../../../../src/public-api";
import { backend } from "../../../../src/server";

// Suggest a custom rule (MCP add_custom_context). Write scope; an admin approves it on the rules page.
const body = z.object({ title: z.string().trim().min(3).max(120), instructions: z.string().trim().min(20).max(2000), repositoryId: convexId.optional() }).strict();
export async function POST(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request, "write");
    const b = body.parse(await request.json());
    try {
      const result = await backend().mutation(api.ruleAssistant.suggestContext, { token, organizationId, title: b.title, instructions: b.instructions, ...(b.repositoryId ? { repositoryId: b.repositoryId as Id<"repositories"> } : {}) });
      return "rejected" in result ? Response.json({ error: `The rule was not accepted: ${result.rejected}` }, { status: 422 }) : Response.json({ suggestionId: result.suggestionId, status: "suggested" }, { status: 201 });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "The suggestion could not be saved; check the repository and your role" }, { status: 400 }); }
  } catch (error) { return apiFailure(error, { status: 400, error: "Invalid request" }); }
}
