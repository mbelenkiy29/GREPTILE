import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { assertEgress, egressAllowed, offline, OfflineError } from "../src/egress";
import { osvEnabled } from "../src/osv";
import { sendEmail, emailConfigured, emailOnWeb } from "../src/email";
import { exchangeSlackCode, SlackApi } from "../src/slack";
import { Linear, linearToken } from "../src/linear";
import { Atlassian, atlassianToken } from "../src/atlassian";
import { Notion, notionToken } from "../src/notion";
import { stripe } from "../src/billing";
import { createDevinSession } from "../src/devin";
import { devinHandoff } from "../src/agent-links";
import { authorizationServerMetadata, loadClientMetadata } from "../src/oauth-server";
import { eligibleTips } from "../src/feature-tips";
import { googleProfile } from "../src/identity";
import { HttpModel } from "../src/engine/model";
import { Embeddings } from "../src/engine/embeddings";
import { Github } from "../src/github";
import { supportedGrammars, verifiedGrammarFile } from "../src/engine/treesitter";

// Every outbound call goes through a spy; offline mode must leave the non-essential spies untouched.
function environment(t: TestContext, values: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}
function spy(response: () => Response = () => Response.json({})) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => { calls.push(String(input instanceof Request ? input.url : input)); return response(); }) as typeof fetch;
  return { fn, calls };
}
const tipSignals = { references: "Fixes https://linear.app/acme/issue/ENG-12", connected: { linear: false, atlassian: false }, rules: 3, recentFindings: 0, dismissedFindings: 0, strictness: 1, engine: "pipeline", agenticAvailable: false };

test("egress policy: online by default; offline keeps only model, embedding, SCM and SSO", () => {
  assert.equal(offline({}), false);
  assert.equal(offline({ OPENREVIEW_OFFLINE: "1" }), false, "only the exact value true turns it on");
  const env = { OPENREVIEW_OFFLINE: "true" };
  assert.equal(offline(env), true);
  for (const kind of ["model", "embedding", "scm", "sso"] as const) assert.equal(egressAllowed(kind, env), true, kind);
  for (const kind of ["advisories", "integrations", "slack", "email", "billing", "handoff", "identity", "oauth-client-metadata", "tips"] as const) {
    assert.equal(egressAllowed(kind, env), false, kind);
    assert.equal(egressAllowed(kind, {}), true, kind);
    assert.throws(() => assertEgress(kind, "Thing", env), (e: unknown) => e instanceof OfflineError && e.kind === kind && /offline mode/.test(e.message));
  }
});

test("offline mode: OSV, email, Slack, Linear, Atlassian, Notion, Stripe, Devin, CIMD, tips and Google sign-in make no requests", async (t) => {
  environment(t, { OPENREVIEW_OFFLINE: "true", OSV_ENABLED: "true", EMAIL_SIGN_IN: "true", RESEND_API_KEY: "re_fixture", EMAIL_FROM: "OpenReview <review@example.com>", GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture" });
  const global = spy();
  t.mock.method(globalThis, "fetch", global.fn);
  const injected = spy();
  const offlineError = (e: unknown) => e instanceof OfflineError;

  assert.equal(osvEnabled(), false, "the review job only builds an OSV client when this is true");
  assert.equal(emailConfigured(), false);
  assert.equal(emailOnWeb(), false, "no email sign-in form even when EMAIL_SIGN_IN=true");
  assert.deepEqual(await sendEmail({ to: "dev@example.com", subject: "Hi", text: "Body" }, injected.fn), { skipped: "Email delivery is not configured" });
  await assert.rejects(exchangeSlackCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://review.example/api/slack/callback" }, injected.fn), offlineError);
  await assert.rejects(new SlackApi("xoxb-fixture", injected.fn).postMessage({ channel: "C123", text: "hello" }), offlineError);
  await assert.rejects(linearToken("client", { refreshToken: "r" }), offlineError);
  await assert.rejects(new Linear("token").issue("ENG-1", { organizationId: "o", teamIds: ["team"], projectIds: [] }), offlineError);
  await assert.rejects(atlassianToken("client", "secret", { refreshToken: "r" }), offlineError);
  await assert.rejects(new Atlassian("token").sites(), offlineError);
  await assert.rejects(notionToken("client", "secret", { refreshToken: "r" }, injected.fn), offlineError);
  await assert.rejects(new Notion("token", injected.fn).page("01234567-89ab-4def-8123-456789abcdef"), offlineError);
  await assert.rejects(stripe("/v1/customers", { name: "Acme" }, "sk_test_fixture", injected.fn), offlineError);
  await assert.rejects(createDevinSession("apk_fixture", "Fix it", "Fix", async (url, init) => injected.fn(url, init)), offlineError);
  assert.equal(devinHandoff(true, true, "review-1"), undefined, "no Send to Devin button offline");
  assert.equal(authorizationServerMetadata("https://review.example").client_id_metadata_document_supported, false);
  const metadata = await loadClientMetadata("https://client.example/oauth/metadata.json", async (url) => { injected.calls.push(String(url)); return { status: 200, contentType: "application/json", body: "{}" }; });
  assert.match(("error" in metadata && metadata.error) || "", /offline mode/);
  assert.deepEqual(eligibleTips(tipSignals), []);
  await assert.rejects(googleProfile("code", "https://review.example/api/auth/google/callback", injected.fn), offlineError);

  assert.deepEqual(global.calls, [], "no request left through the global fetch");
  assert.deepEqual(injected.calls, [], "no request left through an injected fetch");
});

test("offline mode still reaches the configured model, embedding and SCM hosts", async (t) => {
  environment(t, { OPENREVIEW_OFFLINE: "true", EMBEDDING_MODEL: "fixture-embedding", EMBEDDING_BASE_URL: "https://models.internal.example/v1", EMBEDDING_API_KEY: "fixture", LLM_BASE_URL: undefined });
  const global = spy();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    global.calls.push(url);
    if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    if (url.endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: Array(1536).fill(0) }], usage: { prompt_tokens: 1, total_tokens: 1 } });
    void init;
    return Response.json([]);
  });
  const model = new HttpModel({ provider: "compatible", baseUrl: "https://models.internal.example/v1", apiKey: "fixture-only", model: "fixture" });
  assert.deepEqual((await model.generate({ task: "review:offline", system: "Reply", input: {} }, z.object({ ok: z.boolean() }))).value, { ok: true });
  assert.equal((await new Embeddings().embed(["hello"])).vectors.length, 1);
  await new Github("fixture-token").branches("acme/shop");
  assert.deepEqual(global.calls.map((u) => new URL(u).host), ["models.internal.example", "models.internal.example", "api.github.com"]);
});

test("online (default): the same integrations do send their requests", async (t) => {
  environment(t, { OPENREVIEW_OFFLINE: undefined, RESEND_API_KEY: "re_fixture", EMAIL_FROM: "OpenReview <review@example.com>" });
  const injected = spy(() => Response.json({ id: "email-1" }));
  assert.deepEqual(await sendEmail({ to: "dev@example.com", subject: "Hi", text: "Body" }, injected.fn), { id: "email-1" });
  assert.equal(osvEnabled(), true);
  assert.equal(eligibleTips(tipSignals).length, 1);
  assert.equal(authorizationServerMetadata("https://review.example").client_id_metadata_document_supported, true);
  assert.deepEqual(injected.calls, ["https://api.resend.com/emails"]);
});

test("grammar bundle: files load only when they match the SHA-256 manifest", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreview-grammars-"));
  const good = Buffer.from("\0asm fixture grammar"), sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  await writeFile(path.join(dir, "tree-sitter-typescript.wasm"), good);
  await writeFile(path.join(dir, "tree-sitter-python.wasm"), Buffer.from("tampered"));
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ versions: { "tree-sitter-wasms": "fixture" }, files: { "tree-sitter-typescript.wasm": sha(good), "tree-sitter-python.wasm": sha(Buffer.from("original")) } }));
  assert.deepEqual(await verifiedGrammarFile(dir, "tree-sitter-typescript.wasm"), good);
  await assert.rejects(verifiedGrammarFile(dir, "tree-sitter-python.wasm"), /does not match/);
  await assert.rejects(verifiedGrammarFile(dir, "tree-sitter-go.wasm"), /not in the grammar bundle manifest/);
  const supported = supportedGrammars();
  assert.ok(supported.includes("python") && supported.includes("go") && !supported.includes("typescript"), "the bundle covers the tree-sitter languages (TypeScript uses the compiler API)");
  assert.deepEqual(supported, [...new Set(supported)].sort());
});
