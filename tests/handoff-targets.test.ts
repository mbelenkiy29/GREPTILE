import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLinks, codexPromptCap } from "../src/agent-links";
import { createDevinSession, devinApi, validDevinKey, type DevinFetch } from "../src/devin";

test("Conductor: the documented prompt link, pre-filled only, with no local path guessed", () => {
  const conductor = agentLinks("Fix cents & dollars\n#2", { githubSlug: "acme/shop", originUrl: "https://github.com/acme/shop" }).find((l) => l.agent === "conductor")!;
  assert.deepEqual(conductor, { agent: "conductor", label: "Open in Conductor", url: "conductor://prompt=Fix%20cents%20%26%20dollars%0A%232" });
  assert.doesNotMatch(conductor.url!, /path=|branch=/, "path and branch need the local checkout path, which the server does not know");
  const long = agentLinks("x".repeat(codexPromptCap + 1), {}).find((l) => l.agent === "conductor")!;
  assert.deepEqual([long.url, /copy it instead/.test(long.unavailable!)], [undefined, true]);
  assert.deepEqual(agentLinks("x", {}).map((l) => l.agent), ["cursor", "claude", "codex", "conductor"], "Devin has no documented deep link, so it is not a link");
});

test("Devin: documented API request with the user's own key; errors are readable and links stay on Devin", async () => {
  const sent: { url: string; init: Parameters<DevinFetch>[1] }[] = [];
  const respond = (status: number, body: unknown): DevinFetch => async (url, init) => { sent.push({ url, init }); return { status, json: async () => body }; };
  const key = "apk_user_" + "a".repeat(24);
  const created = await createDevinSession(key, "Fix the cents bug", "Totals (acme/shop #5)", respond(200, { session_id: "devin-123", url: "https://app.devin.ai/sessions/devin-123", is_new_session: true }));
  assert.deepEqual(created, { sessionId: "devin-123", url: "https://app.devin.ai/sessions/devin-123" });
  assert.equal(sent[0].url, devinApi);
  assert.equal(devinApi, "https://api.devin.ai/v1/sessions");
  assert.deepEqual([sent[0].init.method, sent[0].init.headers.authorization], ["POST", `Bearer ${key}`]);
  assert.deepEqual(JSON.parse(sent[0].init.body), { prompt: "Fix the cents bug", title: "Totals (acme/shop #5)", unlisted: true });
  await assert.rejects(createDevinSession(key, "p", "t", respond(401, {})), /Devin rejected the API key/);
  await assert.rejects(createDevinSession(key, "p", "t", respond(500, {})), /HTTP 500/);
  await assert.rejects(createDevinSession(key, "p", "t", respond(200, { session_id: "x" })), /unexpected response/);
  await assert.rejects(createDevinSession(key, "p", "t", respond(200, { session_id: "x", url: "https://evil.example/phish" })), /unexpected session link/);
  await assert.rejects(createDevinSession(key, "p", "t", respond(200, { session_id: "x", url: "http://app.devin.ai/s" })), /unexpected session link/);
  const before = sent.length;
  await assert.rejects(createDevinSession("not-a-key", "p", "t", respond(200, {})), /not valid/);
  assert.equal(sent.length, before, "an invalid key is never sent");
  assert.ok(validDevinKey("apk_" + "b".repeat(20)) && validDevinKey(key) && !validDevinKey("apk_short") && !validDevinKey("sk-" + "c".repeat(30)));
});
