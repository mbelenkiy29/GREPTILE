import { z } from "zod";
import type { ChatProgress } from "./chat-stream";

// Shared request schemas and response shapes for the public query API (docs/openapi.yaml).
export const convexId = z.string().regex(/^[A-Za-z0-9]{20,64}$/, "Invalid identifier");
export const queryRequest = z.object({ question: z.string().trim().min(2).max(4000), repositoryIds: z.array(convexId).min(1).max(5), threadId: convexId.optional(), stream: z.boolean().optional() }).strict();
export const searchRequest = z.object({ query: z.string().trim().min(2).max(200), repositoryIds: z.array(convexId).min(1).max(10).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
export const enableRequest = z.object({ repositoryId: convexId }).strict();

type Citation = { repository: string; filePath: string; startLine: number; endLine: number; quote: string; revision: string; url?: string };
export function queryResult(ids: { threadId: string; messageId: string }, p: ChatProgress) {
  return { ...ids, status: p.status, answer: p.status === "completed" ? p.content : null, sources: (p.citations as Citation[]).map((c) => ({ repository: c.repository, path: c.filePath, startLine: c.startLine, endLine: c.endLine, quote: c.quote, revision: c.revision, ...(c.url ? { url: c.url } : {}) })), limits: p.limits, ...(p.error ? { error: p.error } : {}) };
}
// Backend errors become fixed public messages (never echoed verbatim).
export function backendFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/Rate limit/i.test(message)) return Response.json({ error: "Rate limit exceeded; retry after a minute" }, { status: 429 });
  if (/not accessible|Forbidden|not found|Unauthorized|Team access denied/i.test(message)) return Response.json({ error: "Repository or thread not accessible to this API key" }, { status: 404 });
  if (/not been indexed/i.test(message)) return Response.json({ error: "Repository has not been indexed yet" }, { status: 409 });
  if (/Wait for the current answer/i.test(message)) return Response.json({ error: "This thread is still answering a question" }, { status: 409 });
  if (/Viewers cannot/i.test(message)) return Response.json({ error: "The key owner cannot modify repositories" }, { status: 403 });
  return undefined;
}
