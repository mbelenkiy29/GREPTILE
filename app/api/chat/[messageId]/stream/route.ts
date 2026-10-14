import { cookies } from "next/headers";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { backend } from "../../../../../src/server";
import { chatEventStream, sseHeaders } from "../../../../../src/chat-stream";

export const dynamic = "force-dynamic";
// Session-authenticated SSE relay of a chat answer's persisted progress (see src/chat-stream.ts).
export async function GET(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const token = (await cookies()).get("openreview_session")?.value;
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { messageId } = await params;
  if (!/^[a-z0-9]{8,64}$/.test(messageId)) return Response.json({ error: "Invalid message" }, { status: 400 });
  const client = backend(), load = () => client.query(api.chat.progress, { token, messageId: messageId as Id<"chatMessages"> });
  try { await load(); } catch { return Response.json({ error: "Message unavailable or unauthorized" }, { status: 404 }); }
  return new Response(chatEventStream(load, { signal: request.signal }), { headers: sseHeaders });
}
