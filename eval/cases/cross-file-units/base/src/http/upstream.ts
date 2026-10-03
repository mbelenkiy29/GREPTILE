import { requestTimeout } from "../config/timeouts";

/** Calls the upstream service, aborting after the configured timeout. */
export async function callUpstream(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout(process.env) * 1000);
  try {
    return await fetch(url, { method: "POST", body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
