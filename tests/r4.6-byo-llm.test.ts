import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isSealedSecret } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { getOrgLlmSettingsView, LlmSettingsError, parseLlmSettingsForm, saveOrgLlmSettings } from "@/lib/data/llm-settings";
import { modelCalls, orgLlmSettings } from "@/lib/db/schema";
import { runJob, type JobDeps } from "@/lib/jobs/handlers";
import { MemoryQueue } from "@/lib/jobs/types";
import { testModelConnection } from "@/lib/llm/connection-test";
import { FakeEmbeddings, FakeLlm } from "@/lib/llm/fake";
import { gatewayForOrg, invalidateOrgGateway } from "@/lib/llm/org";
import { TEST_SECRET, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { chatCompletion, fakeFetch, jsonResponse } from "./helpers/fake-fetch";

const PUBLIC_DNS = async () => ["93.184.216.34"];
const OPERATOR_ENV = { LLM_PROVIDER: "anthropic", LLM_API_KEY: "operator-anthropic-key" };

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
  invalidateOrgGateway();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function orgWithSettings(fields: Record<string, string>) {
  const { org, user } = await userWithOrg(db, { login: "owner" });
  const view = await saveOrgLlmSettings(db, { orgId: org.id, userId: user.id }, parseLlmSettingsForm(form(fields)), { env: OPERATOR_ENV, resolve: PUBLIC_DNS });
  return { org, user, view };
}

describe("bring your own model provider", () => {
  test("R4.6 BYO LLM settings store the key encrypted and never show it again", async () => {
    const { org, user, view } = await orgWithSettings({
      provider: "openai-compatible",
      baseUrl: "https://llm.acme.dev/v1/",
      apiKey: "acme-secret-key-123",
      model: "acme-coder",
      "taskModel.review": "acme-coder-large",
    });
    expect(view).toMatchObject({ provider: "openai-compatible", baseUrl: "https://llm.acme.dev/v1", model: "acme-coder", hasApiKey: true, taskModels: { review: "acme-coder-large" } });
    expect(JSON.stringify(view)).not.toContain("acme-secret-key-123");
    const [row] = await db.select().from(orgLlmSettings).where(eq(orgLlmSettings.orgId, org.id));
    expect(isSealedSecret(row!.apiKeyEnc!)).toBe(true);
    expect(row!.apiKeyEnc).not.toContain("acme-secret-key-123");

    // Saving again without a key keeps it; changing the endpoint without a new key drops it.
    await saveOrgLlmSettings(db, { orgId: org.id, userId: user.id }, parseLlmSettingsForm(form({ provider: "openai-compatible", baseUrl: "https://llm.acme.dev/v1", model: "acme-coder-2" })), { env: OPERATOR_ENV, resolve: PUBLIC_DNS });
    expect((await getOrgLlmSettingsView(db, org.id))!.hasApiKey).toBe(true);
    await saveOrgLlmSettings(db, { orgId: org.id, userId: user.id }, parseLlmSettingsForm(form({ provider: "openai-compatible", baseUrl: "https://other.acme.dev/v1", model: "x" })), { env: OPERATOR_ENV, resolve: PUBLIC_DNS });
    expect((await getOrgLlmSettingsView(db, org.id))!.hasApiKey).toBe(false);

    expect(() => parseLlmSettingsForm(form({ provider: "openai-compatible", model: "m" }))).toThrow(LlmSettingsError);
    expect(() => parseLlmSettingsForm(form({ provider: "openai" }))).toThrow(/default model/);
    expect(() => parseLlmSettingsForm(form({ provider: "nope" }))).toThrow(LlmSettingsError);
    expect(() => parseLlmSettingsForm(form({ provider: "openai", model: "bad model;" }))).toThrow(LlmSettingsError);
  });

  test("R4.6 BYO LLM endpoints on private networks are rejected unless the operator allows them", async () => {
    const { org, user } = await userWithOrg(db, { login: "owner" });
    const actor = { orgId: org.id, userId: user.id };
    const save = (baseUrl: string, env: Record<string, string> = OPERATOR_ENV, resolve = PUBLIC_DNS) =>
      saveOrgLlmSettings(db, actor, parseLlmSettingsForm(form({ provider: "openai-compatible", baseUrl, model: "m" })), { env, resolve });
    await expect(save("https://169.254.169.254/v1")).rejects.toBeInstanceOf(LlmSettingsError);
    await expect(save("http://llm.acme.dev/v1")).rejects.toThrow(/https/);
    await expect(save("https://localhost:8080/v1")).rejects.toBeInstanceOf(LlmSettingsError);
    await expect(save("https://internal.acme.dev/v1", OPERATOR_ENV, async () => ["10.1.2.3"])).rejects.toThrow(/private/);
    expect(await getOrgLlmSettingsView(db, org.id)).toBeNull();
    await expect(save("http://10.1.2.3:8000/v1", { ...OPERATOR_ENV, LLM_ALLOW_PRIVATE_ORG_ENDPOINTS: "true" })).resolves.toMatchObject({ baseUrl: "http://10.1.2.3:8000/v1" });
  });

  test("R4.6 gatewayForOrg routes an org's model calls, and its jobs, through the org's own endpoint and key", async () => {
    const { org } = await orgWithSettings({ provider: "openai-compatible", baseUrl: "https://llm.acme.dev/v1", apiKey: "acme-secret-key-123", model: "acme-coder", "taskModel.classify": "acme-mini" });
    const http = fakeFetch(() => jsonResponse(chatCompletion("OK")));
    const gateway = await gatewayForOrg(db, org.id, { gateway: { env: OPERATOR_ENV, fetch: http.fetch, resolveHost: PUBLIC_DNS } });
    const result = await testModelConnection(gateway, org.id);
    expect(result.ok).toBe(true);
    expect(http.requests[0]!.url).toBe("https://llm.acme.dev/v1/chat/completions");
    expect(http.requests[0]!.headers.authorization).toBe("Bearer acme-secret-key-123");
    expect((http.requests[0]!.body as { model: string }).model).toBe("acme-mini");
    expect(JSON.stringify(http.requests)).not.toContain("operator-anthropic-key");
    const [call] = await db.select().from(modelCalls);
    expect(call).toMatchObject({ orgId: org.id, model: "acme-mini", provider: "openai-compatible" });

    // An org without settings gets the operator's gateway.
    const other = await userWithOrg(db, { login: "other" });
    const defaultGateway = await gatewayForOrg(db, other.org.id, { gateway: { env: OPERATOR_ENV } });
    expect(defaultGateway.routeFor("classify").provider).toBe("anthropic");

    // Jobs run with the org's gateway when the worker supplies llmForOrg.
    const seen: string[] = [];
    const orgLlm = new FakeLlm();
    const deps: JobDeps = {
      db,
      host: {} as JobDeps["host"],
      queue: new MemoryQueue(),
      llm: new FakeLlm(),
      llmForOrg: async (orgId) => {
        seen.push(orgId);
        return orgLlm;
      },
      embedder: new FakeEmbeddings(),
      cacheDir: "/tmp/unused",
      botMention: "openreview",
    };
    await runJob(deps, "mine-rules", { orgId: org.id, repoId: 999_999 }).catch(() => undefined);
    expect(seen).toEqual([org.id]);
  });

  test("R4.6 a failing org endpoint reports the problem in the connection test", async () => {
    const { org } = await orgWithSettings({ provider: "openai-compatible", baseUrl: "https://llm.acme.dev/v1", apiKey: "k", model: "m" });
    const http = fakeFetch(() => jsonResponse({ error: { message: "invalid api key" } }, 401));
    const gateway = await gatewayForOrg(db, org.id, { gateway: { env: { ...OPERATOR_ENV, LLM_MAX_RETRIES: "0" }, fetch: http.fetch, resolveHost: PUBLIC_DNS, sleep: async () => undefined } });
    const result = await testModelConnection(gateway, org.id);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/^Failed: /);
  });
});
