import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, httpApi, onboard, repositoryFromRemote, type OnboardApi, type OnboardOptions } from "../src/onboard";

// Fake OpenReview API: records calls; repositories flip to enabled when POSTed.
function fakeApi(overrides: { role?: string; others?: boolean; failEnable?: string; repos?: { _id: string; fullName: string; enabled: boolean }[] } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const repos = (overrides.repos ?? [{ _id: "r1", fullName: "acme/shop", enabled: false }, { _id: "r2", fullName: "acme/api", enabled: false }, { _id: "r3", fullName: "acme/done", enabled: true }]).map((r) => ({ ...r, indexStatus: r.enabled ? "ready" : "not_indexed" }));
  const api: OnboardApi = {
    async get(path) {
      calls.push({ method: "GET", path });
      if (path === "/api/workspace") return { workspace: { id: "w1", name: "Acme", role: overrides.role ?? "admin" }, workspaces: [{ id: "w1", name: "Acme", role: "admin", current: true }, ...(overrides.others ? [{ id: "w2", name: "Side project", role: "owner", current: false }] : [])], installUrl: "https://review.example.com/api/github/install?organization=w1", dashboardUrl: "https://review.example.com/dashboard", keysUrl: "https://review.example.com/dashboard/settings/keys", rulesUrl: "https://review.example.com/dashboard/memory/rules" };
      if (path === "/api/repositories") return repos;
      throw new Error("unexpected GET " + path);
    },
    async post(path, body) {
      calls.push({ method: "POST", path, body });
      if (path === "/api/repositories") {
        const repo = repos.find((r) => r._id === (body as { repositoryId: string }).repositoryId)!;
        if (repo.fullName === overrides.failEnable) throw new ApiError(400, "Repository could not be enabled; check the provider installation");
        repo.enabled = true;
        return { enabled: true, indexStatus: "queued" };
      }
      if (path === "/api/rules/import") { const rules = (body as { rules: unknown[] }).rules; return { suggested: rules.length - 1, rejected: [{ title: "Persona", reason: "prompt injection" }] }; }
      throw new Error("unexpected POST " + path);
    },
  };
  return { api, calls };
}
const files = (tree: Record<string, string> = { "AGENTS.md": "## Data\n- Every new query must include an explicit LIMIT.\n- Always validate request bodies with zod.\n" }) => ({ read: async (p: string) => tree[p] ?? null, list: async () => [] as string[] });
// Interactive IO with scripted answers; non-interactive runs must never prompt.
function io(answers: string[] = []) {
  const printed: string[] = [], asked: string[] = [];
  return { printed, asked, io: { ask: async (q: string) => { asked.push(q); if (!answers.length) throw new Error("unexpected prompt: " + q); return answers.shift()!; }, print: (l: string) => { printed.push(l); } } };
}
const options = (extra: Partial<OnboardOptions> = {}): OnboardOptions => ({ yes: false, json: false, rules: true, ...extra });

test("remote URLs resolve to owner/name for repository detection", () => {
  assert.equal(repositoryFromRemote("git@github.com:acme/shop.git"), "acme/shop");
  assert.equal(repositoryFromRemote("https://github.com/acme/shop"), "acme/shop");
  assert.equal(repositoryFromRemote("https://token@gitlab.example.com:8443/group/sub/app.git"), "group/sub/app");
  assert.equal(repositoryFromRemote("ssh://git@github.com/acme/shop.git/"), "acme/shop");
  assert.equal(repositoryFromRemote("not a remote"), undefined);
  assert.equal(repositoryFromRemote(undefined), undefined);
});

test("workspace step: shows the key's workspace; another or a new workspace stops with dashboard steps and changes nothing", async () => {
  const a = fakeApi({ others: true }), t = io(["n"]);
  const stopped = await onboard(a.api, t.io, files(), options());
  assert.equal(stopped.stopped?.step, "workspace");
  assert.match(stopped.stopped!.next, /generate an API key at https:\/\/review\.example\.com\/dashboard\/settings\/keys/);
  assert.deepEqual(a.calls.map((c) => c.method + " " + c.path), ["GET /api/workspace"]);
  const other = fakeApi({ others: true });
  assert.match((await onboard(other.api, io().io, files(), options({ yes: true, workspace: "Side project" }))).stopped!.reason, /belongs to Acme, not Side project/);
  assert.match((await onboard(fakeApi().api, io().io, files(), options({ yes: true, workspace: "nope" }))).stopped!.reason, /No workspace named nope/);
  const created = await onboard(fakeApi().api, io().io, files(), options({ yes: true, createWorkspace: "New team" }));
  assert.match(created.stopped!.next, /Create "New team" at https:\/\/review\.example\.com\/dashboard/);
  // Naming the current workspace (by id or name) continues.
  assert.equal((await onboard(fakeApi().api, io().io, files(), options({ yes: true, workspace: "acme", rules: false }))).stopped, undefined);
});

test("install step prints the provider install link and never calls a provider", async () => {
  const a = fakeApi(), t = io(["", "n"]);
  const summary = await onboard(a.api, t.io, files(), options());
  assert.equal(summary.installUrl, "https://review.example.com/api/github/install?organization=w1");
  assert.ok(t.printed.some((l) => l.includes("Install the GitHub App") && l.includes(summary.installUrl!)));
  assert.ok(a.calls.every((c) => c.path.startsWith("/api/")), "only the OpenReview API is called");
});

test("repositories step: explicit names, all, the detected checkout, interactive choice and per-repository failures", async () => {
  const named = fakeApi();
  const s1 = await onboard(named.api, io().io, files(), options({ yes: true, repositories: "acme/api", rules: false }));
  assert.deepEqual(s1.repositories.enabled, [{ fullName: "acme/api", indexStatus: "queued" }]);
  assert.deepEqual(named.calls.filter((c) => c.method === "POST").map((c) => c.body), [{ repositoryId: "r2" }]);
  const all = fakeApi();
  assert.deepEqual((await onboard(all.api, io().io, files(), options({ yes: true, repositories: "all", rules: false }))).repositories.enabled.map((r) => r.fullName), ["acme/shop", "acme/api"], "already-enabled repositories are left alone");
  await assert.rejects(onboard(fakeApi().api, io().io, files(), options({ yes: true, repositories: "acme/missing" })), /Unknown repositories: acme\/missing/);
  // --yes without a list enables only the repository of the current checkout.
  const detected = await onboard(fakeApi().api, io().io, files(), options({ yes: true, remote: "git@github.com:acme/shop.git", rules: false }));
  assert.deepEqual(detected.repositories.enabled.map((r) => r.fullName), ["acme/shop"]);
  assert.deepEqual((await onboard(fakeApi().api, io().io, files(), options({ yes: true, rules: false }))).repositories.enabled, []);
  // Interactive: blank answer takes the detected checkout; a typed list wins.
  const blank = io([""]);
  assert.deepEqual((await onboard(fakeApi().api, blank.io, files(), options({ remote: "https://github.com/acme/shop.git", rules: false }))).repositories.enabled.map((r) => r.fullName), ["acme/shop"]);
  assert.match(blank.asked[0], /blank for acme\/shop/);
  assert.deepEqual((await onboard(fakeApi().api, io(["acme/api, acme/shop"]).io, files(), options({ rules: false }))).repositories.enabled.map((r) => r.fullName), ["acme/shop", "acme/api"]);
  const failing = await onboard(fakeApi({ failEnable: "acme/api" }).api, io().io, files(), options({ yes: true, repositories: "all", rules: false }));
  assert.deepEqual([failing.repositories.enabled.map((r) => r.fullName), failing.repositories.failed], [["acme/shop"], [{ fullName: "acme/api", error: "Repository could not be enabled; check the provider installation" }]]);
});

test("rules step: discovered files become suggestions scoped to the detected repository; decline and --no-rules import nothing", async () => {
  const a = fakeApi();
  const summary = await onboard(a.api, io().io, files(), options({ yes: true, remote: "git@github.com:acme/shop.git" }));
  const post = a.calls.find((c) => c.path === "/api/rules/import")!;
  assert.equal((post.body as { repositoryId: string }).repositoryId, "r1");
  assert.deepEqual((post.body as { rules: { instructions: string; source: { path: string } }[] }).rules.map((r) => [r.instructions, r.source.path]), [["Every new query must include an explicit LIMIT.", "AGENTS.md"], ["Always validate request bodies with zod.", "AGENTS.md"]]);
  assert.deepEqual([summary.rules.files, summary.rules.candidates, summary.rules.suggested, summary.rules.rejected.length, summary.rules.reviewUrl], [["AGENTS.md"], 2, 1, 1, "https://review.example.com/dashboard/memory/rules"]);
  const declined = fakeApi();
  assert.equal((await onboard(declined.api, io(["", "n"]).io, files(), options())).rules.skipped, "declined");
  assert.equal(declined.calls.some((c) => c.path === "/api/rules/import"), false);
  assert.equal((await onboard(fakeApi().api, io().io, files(), options({ yes: true, rules: false }))).rules.skipped, "disabled with --no-rules");
  assert.equal((await onboard(fakeApi().api, io().io, files({}), options({ yes: true }))).rules.skipped, "no AI rule files found");
});

test("non-interactive: --yes --json never prompts or prints and returns the full summary; --json alone is refused", async () => {
  const t = io();
  const summary = await onboard(fakeApi().api, t.io, files(), options({ yes: true, json: true, repositories: "all" }));
  assert.deepEqual([t.asked, t.printed], [[], []]);
  assert.deepEqual(Object.keys(summary).sort(), ["installUrl", "repositories", "rules", "workspace"]);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)).repositories.alreadyEnabled, ["acme/done"]);
  await assert.rejects(onboard(fakeApi().api, t.io, files(), options({ json: true })), /add --yes/);
});

test("HTTP client sends the Bearer key and turns a rejected key into a login hint", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const ok = httpApi("https://review.example.com", "or_test_key", (async (url: URL, init: RequestInit) => { seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") }); return Response.json({ fine: true }); }) as typeof fetch);
  assert.deepEqual(await ok.get("/api/workspace"), { fine: true });
  assert.deepEqual(seen, [{ url: "https://review.example.com/api/workspace", auth: "Bearer or_test_key" }]);
  const denied = httpApi("https://review.example.com", "or_bad_key", (async () => Response.json({ error: "Invalid or revoked API key" }, { status: 401 })) as typeof fetch);
  await assert.rejects(denied.get("/api/workspace"), /Run openreview login/);
  const forbidden = httpApi("https://review.example.com", "or_read_key", (async () => Response.json({ error: "This API key does not have the admin scope" }, { status: 403 })) as typeof fetch);
  await assert.rejects(forbidden.post("/api/rules/import", {}), /admin scope/);
});
