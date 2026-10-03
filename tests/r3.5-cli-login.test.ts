import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { API_SCOPES } from "@/lib/api/keys";
import { MemoryRateLimiter } from "@/lib/api/rate-limit";
import { decideLogin, findPendingLogin, normalizeUserCode, POLL_INTERVAL_S, type DeviceDeps } from "@/lib/cli/device";
import { listAudit } from "@/lib/data/audit";
import type { Db } from "@/lib/db";
import { apiKeys, cliSessions, orgs, memberships } from "@/lib/db/schema";
import { configPath } from "@/packages/cli/src/config";
import { apiDeps, makeKey } from "./helpers/api";
import { addMember, makeUser } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { CLI_SERVER, cli, testIo, type TestIo } from "./helpers/cli";
import { FixtureRepo } from "./helpers/fixture-repo";

const START = new Date("2026-03-01T12:00:00Z");

async function setup() {
  const db = await createTestDb();
  await db.insert(orgs).values([
    { id: "org_a", name: "Acme", slug: "acme" },
    { id: "org_b", name: "Globex", slug: "globex" },
  ]);
  const owner = await makeUser(db, "olivia");
  const member = await makeUser(db, "mo");
  await addMember(db, "org_a", owner.id, "owner");
  await addMember(db, "org_a", member.id, "member");
  await addMember(db, "org_b", owner.id, "owner");
  const clock = { ms: START.getTime() };
  const device: DeviceDeps = { db, now: () => new Date(clock.ms), limiter: new MemoryRateLimiter(), appUrl: CLI_SERVER };
  const api = apiDeps(db);
  return { db, owner, member, clock, device, api };
}

function post(pathname: string, body: unknown, ip = "203.0.113.7") {
  return new Request(`${CLI_SERVER}${pathname}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
}

/** The user code the CLI printed to stderr. */
function printedCode(io: TestIo): string {
  const m = /confirm the code: ([A-Z]{4}-[A-Z]{4})/.exec(io.err);
  if (!m) throw new Error(`no code in output:\n${io.err}`);
  return m[1]!;
}

async function keyRows(db: Db) {
  return db.select().from(apiKeys);
}

describe("openreview login (R3.5)", () => {
  test("R3.5 login --token verifies the key, stores it in a 0600 config file, and whoami/logout use it; tokens are never printed", async () => {
    const { db, api } = await setup();
    const { token } = await makeKey(db, "org_a", ["repos:read", "reviews:read"]);
    const fixture = new FixtureRepo();
    const io = testIo({ cwd: fixture.dir, deps: { api } });

    const login = await cli(io, "login", "--server", `${CLI_SERVER}/`, "--token", token);
    expect(login.code).toBe(0);
    expect(login.out).toContain("Logged in to Acme on https://review.example.com");
    const file = configPath(io);
    expect(file).toBe(path.join(io.env.XDG_CONFIG_HOME!, "openreview", "config.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ server: CLI_SERVER, token, organization: { id: "org_a", name: "Acme" } });

    const who = await cli(io, "whoami");
    expect(who.code).toBe(0);
    expect(who.out).toContain("Organization: Acme");
    expect(who.out).toContain("Scopes:       repos:read, reviews:read");
    expect(io.requests.at(-1)).toMatchObject({ url: "/api/v1/me", authorization: `Bearer ${token}` });
    expect(io.out + io.err).not.toContain(token);

    // The environment overrides the file.
    const other = await makeKey(db, "org_a", ["findings:read"]);
    const envIo = testIo({ cwd: fixture.dir, deps: { api }, env: { OPENREVIEW_URL: CLI_SERVER, OPENREVIEW_TOKEN: other.token } });
    expect((await cli(envIo, "whoami", "--json")).out).toContain('"findings:read"');

    // `--token -` reads stdin; a malformed key is refused before any request.
    const stdinIo = testIo({ cwd: fixture.dir, deps: { api }, stdin: `${token}\n` });
    expect((await cli(stdinIo, "login", "--server", CLI_SERVER, "--token", "-")).code).toBe(0);
    const bad = await cli(testIo({ cwd: fixture.dir, deps: { api } }), "login", "--server", CLI_SERVER, "--token", "not-a-key");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("That is not an OpenReview API key");

    // A revoked key: login fails with a helpful message and nothing is saved.
    await db.update(apiKeys).set({ revokedAt: START });
    const freshIo = testIo({ cwd: fixture.dir, deps: { api } });
    const revoked = await cli(freshIo, "login", "--server", CLI_SERVER, "--token", token);
    expect(revoked.code).toBe(2);
    expect(revoked.err).toContain("The server rejected your API key: The API key has been revoked.");
    expect(revoked.err).toContain("Run `openreview login` again.");
    expect(revoked.err).not.toContain(token);
    await expect(readFile(configPath(freshIo), "utf8")).rejects.toThrow();

    const out = await cli(io, "logout");
    expect(out.out).toContain("Logged out of https://review.example.com");
    await expect(readFile(file, "utf8")).rejects.toThrow();
    const after = await cli(io, "whoami");
    expect(after.code).toBe(2);
    expect(after.err).toContain("You're not logged in");
    fixture.cleanup();
  });

  test("R3.5 device login end to end: the CLI prints a code, a member approves it for an org, and the CLI receives a key with that member's role scopes", async () => {
    const { db, member, clock, device, api } = await setup();
    const fixture = new FixtureRepo();
    let polls = 0;
    const io = testIo({
      cwd: fixture.dir,
      deps: { api, device },
      onSleep: async (_ms, self) => {
        clock.ms = self.clock.ms;
        polls++;
        // Approve in the browser after the CLI has polled twice.
        if (polls === 3) {
          const code = printedCode(self);
          const pending = await findPendingLogin(db, normalizeUserCode(code)!, new Date(clock.ms));
          expect(pending?.clientHost).toBe("dev-laptop");
          const decided = await decideLogin(db, { userCode: code, userId: member.id, decision: "approve", orgId: "org_a", ip: "198.51.100.1", now: new Date(clock.ms) });
          expect(decided).toMatchObject({ ok: true, status: "approved" });
        }
      },
    });
    const res = await cli(io, "login", "--server", CLI_SERVER);
    expect(res.code).toBe(0);
    expect(io.opened).toEqual([expect.stringMatching(/^https:\/\/review\.example\.com\/cli\/activate\?code=[A-Z]{4}-[A-Z]{4}$/)]);
    expect(res.out).toContain("Logged in to Acme");
    expect(io.requests.filter((r) => r.url === "/api/cli/token")).toHaveLength(3);

    const [key] = await keyRows(db);
    expect(key).toMatchObject({ orgId: "org_a", name: "CLI on dev-laptop", createdBy: member.id });
    // A member gets every read scope and the writes their role allows (not rules:write or repos:write).
    expect(key!.scopes).toEqual(["repos:read", "reviews:read", "reviews:write", "findings:read", "findings:write", "rules:read", "knowledge:read"]);
    expect(key!.expiresAt!.getTime() - key!.createdAt.getTime()).toBe(365 * 86_400_000);
    const saved = JSON.parse(await readFile(configPath(io), "utf8")) as { token: string };
    expect(io.out + io.err).not.toContain(saved.token);
    expect((await cli(io, "whoami")).out).toContain("CLI on dev-laptop");

    const [session] = await db.select().from(cliSessions);
    expect(session).toMatchObject({ status: "approved", orgId: "org_a", userId: member.id, apiKeyId: key!.id });
    expect(session!.deliveredAt).not.toBeNull();
    // Only the hash of the device code is stored.
    const deviceCode = (io.requests.find((r) => r.url === "/api/cli/token")!.body as { device_code: string }).device_code;
    expect(JSON.stringify(session)).not.toContain(deviceCode);
    const audit = (await listAudit(db, "org_a")).map((a) => a.action).sort();
    expect(audit).toEqual(["api_key.created", "cli.login_approved"]);

    // The token is handed out once: polling again with the same device code fails.
    clock.ms += 60_000;
    const again = await pollRaw(device, deviceCode);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid_grant");
    expect(await keyRows(db)).toHaveLength(1);
    fixture.cleanup();
  });

  test("R3.5 device login: denial, expiry, polling too fast, and tenant safety (only the approver's own orgs)", async () => {
    const { db, owner, member, clock, device } = await setup();
    const start = async () => (await (await import("@/lib/cli/device")).startDeviceLogin(device, post("/api/cli/device", { clientHost: "ci box; rm -rf" }))).json();

    // Deny.
    const denied = (await start()) as { device_code: string; user_code: string; interval: number; expires_in: number; verification_uri: string };
    expect(denied).toMatchObject({ interval: POLL_INTERVAL_S, expires_in: 600, verification_uri: `${CLI_SERVER}/cli/activate` });
    expect(denied.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect((await (await pollRaw(device, denied.device_code)).json()).error).toBe("authorization_pending");
    // Polling again within the interval: slow down.
    clock.ms += 1000;
    const fast = await pollRaw(device, denied.device_code);
    expect(fast.status).toBe(400);
    expect(await fast.json()).toMatchObject({ error: "slow_down", interval: POLL_INTERVAL_S * 2 });
    expect(await decideLogin(db, { userCode: denied.user_code.toLowerCase(), userId: member.id, decision: "deny", now: new Date(clock.ms) })).toMatchObject({ ok: true, status: "denied" });
    clock.ms += 10_000;
    expect((await (await pollRaw(device, denied.device_code)).json()).error).toBe("access_denied");
    // A decided code cannot be decided again.
    expect(await decideLogin(db, { userCode: denied.user_code, userId: member.id, decision: "approve", orgId: "org_a", now: new Date(clock.ms) })).toEqual({ ok: false, error: "not_found" });

    // Tenant safety: a member cannot approve a login into an org they do not belong to.
    const foreign = (await start()) as { device_code: string; user_code: string };
    expect(await decideLogin(db, { userCode: foreign.user_code, userId: member.id, decision: "approve", orgId: "org_b", now: new Date(clock.ms) })).toEqual({ ok: false, error: "not_member" });
    expect(await decideLogin(db, { userCode: "NOT-A-CODE!", userId: member.id, decision: "approve", orgId: "org_a", now: new Date(clock.ms) })).toEqual({ ok: false, error: "invalid_code" });
    // The owner approves it for org_b; the key lands in org_b with owner scopes, never in org_a.
    expect(await decideLogin(db, { userCode: foreign.user_code, userId: owner.id, decision: "approve", orgId: "org_b", now: new Date(clock.ms) })).toMatchObject({ ok: true });
    clock.ms += 10_000;
    const granted = await pollRaw(device, foreign.device_code);
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as { access_token: string; organization: { id: string }; scope: string };
    expect(body.organization.id).toBe("org_b");
    expect(body.scope.split(" ")).toEqual([...API_SCOPES]);
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.orgId, "org_b"));
    expect(key!.name).toBe("CLI on ciboxrm-rf");
    expect(await db.select().from(apiKeys).where(eq(apiKeys.orgId, "org_a"))).toEqual([]);

    // Approved, but the approver left the org before the CLI collected the key: no key.
    const left = (await start()) as { device_code: string; user_code: string };
    await decideLogin(db, { userCode: left.user_code, userId: member.id, decision: "approve", orgId: "org_a", now: new Date(clock.ms) });
    await db.delete(memberships).where(eq(memberships.userId, member.id));
    clock.ms += 10_000;
    expect((await (await pollRaw(device, left.device_code)).json()).error).toBe("access_denied");
    expect(await db.select().from(apiKeys).where(eq(apiKeys.orgId, "org_a"))).toEqual([]);

    // Expiry: ten minutes after the start the code is dead, approved or not.
    const late = (await start()) as { device_code: string; user_code: string };
    clock.ms += 10 * 60_000 + 1;
    expect(await decideLogin(db, { userCode: late.user_code, userId: owner.id, decision: "approve", orgId: "org_a", now: new Date(clock.ms) })).toEqual({ ok: false, error: "not_found" });
    expect((await (await pollRaw(device, late.device_code)).json()).error).toBe("expired_token");
    expect((await db.select().from(cliSessions).where(eq(cliSessions.userCode, normalizeUserCode(late.user_code)!)))[0]!.status).toBe("expired");
    expect((await (await pollRaw(device, "ordc_unknown")).json()).error).toBe("invalid_grant");
  });

  test("R3.5 device login endpoints are rate-limited per client address", async () => {
    const { device } = await setup();
    const { startDeviceLogin } = await import("@/lib/cli/device");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await startDeviceLogin(device, post("/api/cli/device", {}, "192.0.2.1"))).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    const limited = await startDeviceLogin(device, post("/api/cli/device", {}, "192.0.2.1"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    // Another address is unaffected.
    expect((await startDeviceLogin(device, post("/api/cli/device", {}, "192.0.2.2"))).status).toBe(200);
    // Token polls have their own per-address budget.
    const polls: number[] = [];
    for (let i = 0; i < 61; i++) polls.push((await pollRaw(device, "ordc_x", "192.0.2.3")).status);
    expect(polls.at(-1)).toBe(429);
    expect(polls.slice(0, 60).every((s) => s === 400)).toBe(true);
  });

  test("R3.5 login explains denial and expiry in the terminal, and works with --no-browser", async () => {
    const { db, member, clock, device, api } = await setup();
    const fixture = new FixtureRepo();
    const io = testIo({
      cwd: fixture.dir,
      deps: { api, device },
      onSleep: async (_ms, self) => {
        clock.ms = self.clock.ms;
        await decideLogin(db, { userCode: printedCode(self), userId: member.id, decision: "deny", now: new Date(clock.ms) });
      },
    });
    const denied = await cli(io, "login", "--server", CLI_SERVER, "--no-browser");
    expect(denied.code).toBe(2);
    expect(io.opened).toEqual([]);
    expect(denied.err).toContain("error: The login was denied");

    const expiring = testIo({ cwd: fixture.dir, deps: { api, device }, onSleep: (_ms, self) => void (clock.ms = self.clock.ms) });
    const expired = await cli(expiring, "login", "--server", CLI_SERVER);
    expect(expired.code).toBe(2);
    expect(expired.err).toContain("The login code expired before it was approved.");

    const noServer = await cli(testIo({ cwd: fixture.dir }), "login");
    expect(noServer.err).toContain("Which OpenReview server?");
    const unreachable = await cli(
      testIo({ cwd: fixture.dir, fetchImpl: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) }),
      "login",
      "--server",
      "https://down.example.com",
    );
    expect(unreachable.code).toBe(2);
    expect(unreachable.err).toContain("Can't reach the OpenReview server at https://down.example.com (ECONNREFUSED)");
    fixture.cleanup();
  });
});

async function pollRaw(device: DeviceDeps, deviceCode: string, ip = "203.0.113.7") {
  const { pollDeviceToken } = await import("@/lib/cli/device");
  return pollDeviceToken(device, post("/api/cli/token", { device_code: deviceCode }, ip));
}
