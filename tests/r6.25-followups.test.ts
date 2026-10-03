import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import nextConfig from "@/next.config";
import { orgReviewEngine } from "@/lib/api/review-engine";
import { orgsWithUsageLimits } from "@/lib/billing/alerts";
import { billingConfig } from "@/lib/billing/plans";
import { reportUsage } from "@/lib/billing/report";
import type { StripeApi } from "@/lib/billing/stripe";
import { syncAllSubscriptions } from "@/lib/billing/subscriptions";
import { parseLlmSettingsForm, saveOrgLlmSettings } from "@/lib/data/llm-settings";
import { billingAccounts, installations, modelCalls, orgs, usageSettings } from "@/lib/db/schema";
import { isSystemOrg } from "@/lib/demo/ids";
import { DEMO_ORG_ID, DEMO_PROVIDER, ensureDemoOrg } from "@/lib/demo/org";
import { billingEnv } from "@/lib/env";
import { clientFor, GitHosts, hostFor, UnsupportedProviderError } from "@/lib/git/hosts";
import { invalidateOrgGateway } from "@/lib/llm/org";
import { apiDeps, call, json, makeKey } from "./helpers/api";
import { makeUser, TEST_SECRET } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { HEAD_PRICING, BASE_FILES, reviewFixture } from "./helpers/review-fixture";
import { patchBetween } from "./helpers/engine";
import { fakeFetch, jsonResponse } from "./helpers/fake-fetch";
import { FakeGitHost } from "./helpers/fake-git";

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DNS = async () => ["93.184.216.34"];
const OPERATOR_ENV = { LLM_PROVIDER: "anthropic", LLM_API_KEY: "operator-anthropic-key", LLM_MAX_RETRIES: "0" };

beforeEach(() => {
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

describe("follow-ups found during integration (R6.25)", () => {
  test("R6.25 CLI server-mode reviews run on the org's own model provider when it configured one", async () => {
    const fx = await reviewFixture();
    const owner = await makeUser(fx.db, "owner");
    await saveOrgLlmSettings(
      fx.db,
      { orgId: "org_a", userId: owner.id },
      parseLlmSettingsForm(form({ provider: "openai-compatible", baseUrl: "https://llm.acme.dev/v1", apiKey: "acme-org-key-123", model: "acme-coder" })),
      { env: OPERATOR_ENV, resolve: PUBLIC_DNS },
    );
    // The org's endpoint is down: the review fails, but every model request went to the org's endpoint with its key.
    const http = fakeFetch(() => jsonResponse({ error: { message: "maintenance" } }, 500));
    const engine = orgReviewEngine({ db: fx.db, gateway: { gateway: { env: OPERATOR_ENV, fetch: http.fetch, resolveHost: PUBLIC_DNS, sleep: async () => undefined } } });
    const seen: string[] = [];
    const deps = apiDeps(fx.db, {
      reviewEngine: (orgId) => {
        seen.push(orgId);
        return engine(orgId);
      },
    });
    const key = await makeKey(fx.db, "org_a", ["reviews:write"]);
    const pricing = "services/billing/pricing.ts";
    const body = {
      repositoryId: fx.repo.id,
      baseSha: fx.base,
      headSha: fx.head,
      files: [{ path: pricing, status: "modified", patch: patchBetween(BASE_FILES[pricing], HEAD_PRICING) }],
      headFiles: { [pricing]: HEAD_PRICING },
    };
    const res = await call(deps, "POST /reviews/local", { token: key.token, body });
    expect(res.status).toBe(503);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain("The review model failed");
    expect(seen).toEqual(["org_a"]);
    expect(http.requests.length).toBeGreaterThan(0);
    for (const r of http.requests) {
      expect(r.url).toBe("https://llm.acme.dev/v1/chat/completions");
      expect(r.headers.authorization).toBe("Bearer acme-org-key-123");
    }
    expect(JSON.stringify(http.requests)).not.toContain("operator-anthropic-key");
    const calls = await fx.db.select().from(modelCalls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.orgId === "org_a" && c.provider === "openai-compatible")).toBe(true);

    // An org without its own provider gets the operator's gateway.
    await fx.db.insert(orgs).values({ id: "org_plain", name: "Plain" });
    const plain = await orgReviewEngine({ db: fx.db, gateway: { gateway: { env: OPERATOR_ENV } } })("org_plain");
    expect((plain.llm as unknown as { routeFor(task: string): { provider: string } }).routeFor("review").provider).toBe("anthropic");
  });

  test("R6.25 the public demo org's placeholder installation never gets a git client", async () => {
    const db = await createTestDb();
    await ensureDemoOrg(db);
    const [demo] = await db.select().from(installations);
    expect(demo).toMatchObject({ orgId: DEMO_ORG_ID, provider: DEMO_PROVIDER });
    const github = new FakeGitHost();
    const hosts = new GitHosts(github, { gitlab: new FakeGitHost() });
    for (const host of [hosts, github]) {
      expect(() => clientFor(host, demo!)).toThrow(UnsupportedProviderError);
      expect(() => hostFor(host, DEMO_PROVIDER)).toThrow("the public demo's placeholder installation");
    }
    expect(() => hosts.forProvider(DEMO_PROVIDER)).toThrow(UnsupportedProviderError);
    // Real providers still resolve.
    expect(hostFor(hosts, "github")).toBe(github);
    expect(isSystemOrg(DEMO_ORG_ID)).toBe(true);
    expect(isSystemOrg("org_a")).toBe(false);
  });

  test("R6.25 billing and usage-alert sweeps skip the public demo org", async () => {
    const db = await createTestDb();
    await ensureDemoOrg(db);
    await db.insert(orgs).values({ id: "org_a", name: "Acme" });
    for (const orgId of [DEMO_ORG_ID, "org_a"]) {
      await db.insert(usageSettings).values({ orgId, monthlyCreditCap: 100 });
    }
    const key = ["sk", "test", "openreview", "fixture"].join("_");
    const on = billingConfig(
      billingEnv({ APP_URL: "https://review.example.com", STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: "whsec_fixture", STRIPE_PRICE_TEAM_SEAT: "price_seat", STRIPE_PRICE_OVERAGE: "price_over" }),
    );
    const off = billingConfig(billingEnv({ APP_URL: "https://review.example.com" }));
    expect(await orgsWithUsageLimits(db, off)).toEqual(["org_a"]);
    expect(await orgsWithUsageLimits(db, on)).toEqual(["org_a"]);

    // A (hypothetical) paid account on the demo org is never synced or billed.
    await db.insert(billingAccounts).values({ orgId: DEMO_ORG_ID, plan: "team", status: "active", stripeCustomerId: "cus_demo", stripeSubscriptionId: "sub_demo", stripeSeatItemId: "si_demo", seats: 1 });
    const stripeCalls: string[] = [];
    const stripe = new Proxy({} as StripeApi, {
      get: (_t, prop) => async () => {
        stripeCalls.push(String(prop));
        throw new Error("Stripe must not be called for the demo org");
      },
    });
    expect(await syncAllSubscriptions({ db, cfg: on, stripe: () => stripe })).toEqual({ orgs: 0, failed: 0 });
    const report = await reportUsage({ db, cfg: off });
    expect(report).toMatchObject({ billing: null, alertOrgs: 1 });
    expect(stripeCalls).toEqual([]);
  });

  test("R6.25 next dev is configured not to write its agent-rules block into CLAUDE.md", () => {
    expect(nextConfig.agentRules).toBe(false);
    const claude = readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("BEGIN:nextjs-agent-rules");
    expect(claude.startsWith("# OpenReview")).toBe(true);
  });
});
