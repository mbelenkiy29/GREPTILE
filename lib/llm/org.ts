/**
 * The model gateway for one org (R4.6): the operator's configuration, or the org's own provider when it saved one in
 * Settings → Model provider. Gateways are cached for a short while per process so a burst of jobs does not re-read
 * and re-decrypt the settings for every call; saving settings invalidates the entry in the saving process, and other
 * processes pick the change up within {@link ORG_GATEWAY_TTL_MS}.
 */
import type { Db } from "@/lib/db";
import { getOrgLlmSettings, overrideFromRow } from "@/lib/data/llm-settings";
import { errorMessage } from "@/lib/log";
import { createGateway, type GatewayOptions, type ModelGateway } from "./gateway";
import { llm } from "./index";
import { PostgresModelCallRecorder } from "./recorder";
import { LlmError } from "./types";

export const ORG_GATEWAY_TTL_MS = 30_000;

interface Entry {
  gateway: ModelGateway;
  at: number;
}

const cache = new Map<string, Entry>();
let operatorGateway: { db: Db; gateway: ModelGateway } | undefined;

/** Drops a cached org gateway (after its settings change), or all of them. */
export function invalidateOrgGateway(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

export interface GatewayForOrgOptions {
  /** Extra gateway options (tests inject `env`, `fetch`, `resolveHost`); bypasses the cache. */
  gateway?: Omit<GatewayOptions, "orgOverride">;
  now?: () => number;
}

/**
 * The gateway every model call made for `orgId` should use. Throws LlmError when the org's stored key cannot be
 * decrypted (e.g. ENCRYPTION_KEY changed): its calls must never silently fall back to the operator's model.
 */
export async function gatewayForOrg(db: Db, orgId: string, opts: GatewayForOrgOptions = {}): Promise<ModelGateway> {
  const now = (opts.now ?? Date.now)();
  if (!opts.gateway) {
    const hit = cache.get(orgId);
    if (hit && now - hit.at < ORG_GATEWAY_TTL_MS) return hit.gateway;
  }
  const row = await getOrgLlmSettings(db, orgId);
  let gateway: ModelGateway;
  if (!row) {
    if (opts.gateway) {
      gateway = createGateway({ recorder: new PostgresModelCallRecorder(db), ...opts.gateway });
    } else {
      if (operatorGateway?.db !== db) operatorGateway = { db, gateway: llm({ db }) };
      gateway = operatorGateway.gateway;
    }
  } else {
    let orgOverride;
    try {
      orgOverride = overrideFromRow(row);
    } catch (err) {
      throw new LlmError(`the organization's model provider settings could not be read (save them again): ${errorMessage(err)}`, { retryable: false, cause: err });
    }
    gateway = opts.gateway
      ? createGateway({ recorder: new PostgresModelCallRecorder(db), ...opts.gateway, orgOverride })
      : llm({ db, orgOverride });
  }
  if (!opts.gateway) cache.set(orgId, { gateway, at: now });
  return gateway;
}
