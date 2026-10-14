import { z } from "zod";

// Devin handoff (opt-in). Devin documents no "open with prompt" link, only its API: POST
// https://api.devin.ai/v1/sessions with `Authorization: Bearer <personal (apk_user_…) or service (apk_…) key>`
// and a JSON body whose only required field is `prompt`; the response carries `session_id` and `url`
// (docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session, checked 2026-10-14). OpenReview
// uses the developer's own key, stored encrypted, only when they click "Send to Devin".
export const devinApi = "https://api.devin.ai/v1/sessions";
export const validDevinKey = (key: string) => /^apk_[A-Za-z0-9_-]{10,300}$/.test(key);
const sessionResponse = z.object({ session_id: z.string().min(1), url: z.string().url() }).passthrough();
export type DevinFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function createDevinSession(key: string, prompt: string, title: string, fetcher: DevinFetch = (url, init) => fetch(url, init)) {
  if (!validDevinKey(key)) throw new Error("The saved Devin API key is not valid; replace it in Personal agents.");
  const response = await fetcher(devinApi, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: prompt.slice(0, 30_000), title: title.slice(0, 120), unlisted: true }), signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) throw new Error("Devin rejected the API key; replace it in Personal agents.");
  if (response.status !== 200 && response.status !== 201) throw new Error(`Devin could not start a session (HTTP ${response.status}).`);
  const parsed = sessionResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Devin returned an unexpected response.");
  const url = new URL(parsed.data.url);
  // Only send the browser to Devin's own HTTPS hosts.
  if (url.protocol !== "https:" || !(url.hostname === "devin.ai" || url.hostname.endsWith(".devin.ai"))) throw new Error("Devin returned an unexpected session link.");
  return { sessionId: parsed.data.session_id, url: url.toString() };
}
