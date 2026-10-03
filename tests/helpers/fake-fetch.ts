/**
 * An in-process `fetch` for provider tests: records every request and answers from a responder, so the real SDK /
 * HTTP code paths run without the network (H4).
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body (undefined for bodiless requests). */
  body: unknown;
  signal?: AbortSignal;
}

export type Responder = (req: RecordedRequest, index: number) => Response | Error | Promise<Response | Error>;

export function fakeFetch(responder: Responder) {
  const requests: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: raw ? JSON.parse(raw) : undefined,
      signal: init?.signal ?? undefined,
    };
    requests.push(req);
    const res = await responder(req, requests.length - 1);
    if (res instanceof Error) throw res;
    return res;
  };
  // The DOM `fetch` type also declares static members (e.g. `preconnect`) that a plain function lacks.
  return { fetch: impl as typeof fetch, requests };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A Messages API response body. */
export function anthropicMessage(o: {
  model?: string;
  text?: string;
  stopReason?: string;
  explanation?: string;
  usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>;
}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: o.model ?? "claude-opus-5-5",
    content: o.text === undefined ? [] : [{ type: "text", text: o.text }],
    stop_reason: o.stopReason ?? "end_turn",
    stop_sequence: null,
    stop_details: o.stopReason === "refusal" ? { type: "refusal", category: null, explanation: o.explanation ?? null } : null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o.usage },
  };
}

/** An OpenAI chat completion response body. */
export function chatCompletion(content: string | null, o: { refusal?: string; usage?: { prompt_tokens: number; completion_tokens: number; cached?: number }; model?: string } = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: o.model,
    choices: [{ index: 0, message: { role: "assistant", content, refusal: o.refusal ?? null }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: o.usage?.prompt_tokens ?? 50,
      completion_tokens: o.usage?.completion_tokens ?? 10,
      prompt_tokens_details: { cached_tokens: o.usage?.cached ?? 0 },
    },
  };
}
