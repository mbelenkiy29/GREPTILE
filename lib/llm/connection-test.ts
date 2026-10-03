/**
 * "Test connection" for an org's model provider (R4.6): one tiny `classify` call through the gateway, so it exercises
 * the same routing, SSRF check, key, and endpoint as real calls (and is recorded in `model_calls` like them).
 */
import { errorMessage } from "@/lib/log";
import type { ModelGateway } from "./gateway";

export interface ConnectionTestResult {
  ok: boolean;
  lines: string[];
}

export async function testModelConnection(gateway: ModelGateway, orgId: string, now: () => number = Date.now): Promise<ConnectionTestResult> {
  const started = now();
  try {
    const route = gateway.routeFor("classify");
    const res = await gateway.text({
      task: "classify",
      system: "You check that a model endpoint works. Answer with the single word OK.",
      prompt: "Reply with OK.",
      maxTokens: 32,
      meta: { orgId, agent: "connection-test" },
    });
    return {
      ok: true,
      lines: [
        `${route.provider} answered with model ${res.servedModel ?? res.route.model} in ${now() - started} ms.`,
        `Reply: ${res.text.trim().slice(0, 80) || "(empty)"}`,
      ],
    };
  } catch (err) {
    return { ok: false, lines: [`Failed: ${errorMessage(err)}`] };
  }
}
