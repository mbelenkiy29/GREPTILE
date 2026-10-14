// Server-sent events for codebase chat. Model keys live only in Convex, so the browser never talks
// to the model: the Convex job persists progress events and the validated answer, and this relay
// (run by a Next.js route with the member's session) polls them and forwards new events.
export type ChatProgress = { status: string; events: { at: number; kind: string; text: string }[]; content: string; citations: unknown[]; limits: string[]; error?: string };

export function chatEventStream(load: () => Promise<ChatProgress>, options: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const encoder = new TextEncoder(), interval = options.intervalMs ?? 500, deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const seen = new Set<string>();
      try {
        while (!options.signal?.aborted) {
          const progress = await load();
          for (const e of progress.events) {
            const key = `${e.at}:${e.kind}:${e.text}`;
            if (!seen.has(key)) { seen.add(key); send("progress", { kind: e.kind, text: e.text }); }
          }
          if (progress.status === "completed") { send("answer", { content: progress.content, citations: progress.citations, limits: progress.limits }); break; }
          if (progress.status === "failed") { send("error", { error: progress.error ?? "Chat failed", limits: progress.limits }); break; }
          if (Date.now() > deadline) { send("timeout", { message: "Still working; reload to see the latest state." }); break; }
          await sleep(interval);
        }
      } catch {
        send("error", { error: "The progress stream was interrupted; reload to see the latest state." });
      }
      controller.close();
    },
  });
}
export const sseHeaders = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };
