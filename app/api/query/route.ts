import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { apiFailure, apiIdentity } from "../../../src/api-auth";
import { backend } from "../../../src/server";
import { chatEventStream, sseHeaders } from "../../../src/chat-stream";
import { backendFailure, queryRequest, queryResult } from "../../../src/public-api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
// Ask a question over repositories: the codebase-chat engine answers with validated sources.
export async function POST(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request, "read");
    const body = queryRequest.parse(await request.json());
    const client = backend();
    let ids;
    try {
      ids = await client.mutation(api.chat.ask, { token, organizationId, question: body.question, repositoryIds: body.repositoryIds as Id<"repositories">[], ...(body.threadId ? { threadId: body.threadId as Id<"chatThreads"> } : {}), origin: "api" });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "Question rejected" }, { status: 400 }); }
    const load = () => client.query(api.chat.progress, { token, messageId: ids.messageId });
    if (body.stream) return new Response(chatEventStream(load, { signal: request.signal, prelude: [{ event: "thread", data: ids }], answer: (p) => queryResult(ids, p) }), { headers: sseHeaders });
    const deadline = Date.now() + 280_000;
    for (;;) {
      const progress = await load();
      const done = progress.status === "completed" || progress.status === "failed";
      if (done || Date.now() > deadline || request.signal.aborted) return Response.json(queryResult(ids, progress), { status: progress.status === "completed" ? 200 : progress.status === "failed" ? 422 : 202, headers: { "cache-control": "no-store" } });
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
