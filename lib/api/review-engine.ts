/**
 * The review engine dependencies for reviews the API runs itself (`POST /api/v1/reviews/local`, R3.5): the org's own
 * model provider when it configured one in Settings → Model provider (R4.6), otherwise the operator's, exactly as the
 * worker reviews that org's pull requests (`gatewayForOrg`).
 */
import type { Db } from "@/lib/db";
import type { EmbeddingProvider } from "@/lib/llm/types";
import { gatewayForOrg, type GatewayForOrgOptions } from "@/lib/llm/org";
import type { ReviewEngineDeps } from "./router";

export function orgReviewEngine(opts: {
  db: Db;
  /** Embeddings stay the server's (orgs bring their own chat model only). */
  embedder?: () => EmbeddingProvider;
  /** Gateway options for tests (env, fetch, DNS); production uses the cached per-org gateway. */
  gateway?: GatewayForOrgOptions;
}): (orgId: string) => Promise<ReviewEngineDeps> {
  return async (orgId) => {
    const llm = await gatewayForOrg(opts.db, orgId, opts.gateway);
    const embedder = opts.embedder?.();
    return { llm, ...(embedder ? { embedder } : {}) };
  };
}
