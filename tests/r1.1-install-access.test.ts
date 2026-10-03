import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getUserGitHubToken, listUserInstallations, userCanAccessInstallation } from "@/lib/auth/github-user";
import { createInstallCallbackHandler, createInstallStartHandler, type InstallDeps } from "@/lib/auth/install";
import { listInstallations, listRepos } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { authAccounts } from "@/lib/db/schema";
import { signInstallState, verifyInstallState } from "@/lib/github/install-state";
import { addMember, fakeGitHub, makeUser, NOW, signedInCookie, TEST_SECRET, testAuthConfig, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";

const config = { ...testAuthConfig, appSlug: "openreview-test" };
const USER_TOKEN = "ghu_installcheck000000000000000000000";
const HOUR = 60 * 60 * 1000;

let db: Db;
let host: FakeGitHost;

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
  host = new FakeGitHost();
  host.addInstallation(11, "acme", [
    { id: 1, fullName: "acme/api", defaultBranch: "main", private: true },
    { id: 2, fullName: "acme/web", defaultBranch: "main", private: false },
  ]);
  host.addInstallation(22, "globex", [{ id: 3, fullName: "globex/core", defaultBranch: "main", private: true }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function callbackHandler(gh: ReturnType<typeof fakeGitHub>, enqueued: number[][] = []) {
  const deps: InstallDeps = {
    db,
    config,
    host,
    fetch: gh.fetch,
    now: () => NOW,
    enqueue: async (repos) => {
      enqueued.push(repos.map((r) => r.externalId));
    },
  };
  return createInstallCallbackHandler(() => deps);
}

const callbackUrl = (state: string, installationId: number | string = 11) =>
  `${config.appUrl}/api/github/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`;

const outcome = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("install");

async function ownerWithToken(expiresAt: Date | null = new Date(NOW.getTime() + 8 * HOUR)) {
  return userWithOrg(db, { login: "olive", orgName: "Acme", githubToken: { token: USER_TOKEN, expiresAt } });
}

describe("GitHub App install flow (access verified)", () => {
  test("R1.1 install start requires repos.manage and binds the org and the user in the signed state", async () => {
    const owner = await ownerWithToken();
    const start = createInstallStartHandler(() => ({ db, config, now: () => NOW }));
    const res = await start(new Request(`${config.appUrl}/api/github/install`, { headers: { cookie: owner.cookie } }));
    const url = new URL(res.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.example/apps/openreview-test/installations/new");
    expect(verifyInstallState(TEST_SECRET, url.searchParams.get("state")!, NOW.getTime())).toEqual({ orgId: owner.org.id, userId: owner.user.id });

    const member = await makeUser(db, "milo");
    await addMember(db, owner.org.id, member.id, "member");
    const asMember = await start(new Request(`${config.appUrl}/api/github/install`, { headers: { cookie: (await signedInCookie(db, member.id, owner.org.id)).cookie } }));
    expect(asMember.headers.get("location")).toBe("https://review.example.com/dashboard/repos?install=forbidden");

    const anon = await start(new Request(`${config.appUrl}/api/github/install`));
    expect(anon.headers.get("location")).toBe("https://review.example.com/sign-in?next=%2Fapi%2Fgithub%2Finstall");
  });

  test("R1.1 install callback rejects an installation the signed-in user cannot access", async () => {
    const owner = await ownerWithToken();
    const gh = fakeGitHub({ installations: [22] });
    const state = signInstallState(TEST_SECRET, owner.org.id, NOW.getTime(), owner.user.id);
    const res = await callbackHandler(gh)(new Request(callbackUrl(state, 11), { headers: { cookie: owner.cookie } }));
    expect(outcome(res)).toBe("not_accessible");
    expect(gh.calls.map((c) => [c.url, c.authorization])).toEqual([[`${config.githubApiUrl}/user/installations?per_page=100`, `Bearer ${USER_TOKEN}`]]);
    expect(await listInstallations(db, owner.org.id)).toEqual([]);
    expect(await listRepos(db, owner.org.id)).toEqual([]);
  });

  test("R1.1 install callback links an installation the user can access to the active org and queues indexing", async () => {
    const owner = await ownerWithToken();
    // The user's installations span two pages; 11 is on the second.
    const gh = fakeGitHub({ installations: [5, 6, 11], pageSize: 2 });
    const enqueued: number[][] = [];
    const state = signInstallState(TEST_SECRET, owner.org.id, NOW.getTime(), owner.user.id);
    const res = await callbackHandler(gh, enqueued)(new Request(callbackUrl(state, 11), { headers: { cookie: owner.cookie } }));
    expect(res.headers.get("location")).toBe("https://review.example.com/dashboard/repos?install=ok");
    expect((await listInstallations(db, owner.org.id)).map((i) => [i.externalId, i.accountLogin])).toEqual([[11, "acme"]]);
    expect((await listRepos(db, owner.org.id)).map((r) => r.fullName)).toEqual(["acme/api", "acme/web"]);
    expect(enqueued).toEqual([[1, 2]]);
    expect(gh.calls).toHaveLength(2);

    // The same helpers are reusable for claiming installations created outside the callback.
    expect(await userCanAccessInstallation(USER_TOKEN, 6, { fetch: gh.fetch, apiUrl: config.githubApiUrl })).toBe(true);
    expect(await userCanAccessInstallation(USER_TOKEN, 22, { fetch: gh.fetch, apiUrl: config.githubApiUrl })).toBe(false);
    expect((await listUserInstallations(USER_TOKEN, { fetch: gh.fetch, apiUrl: config.githubApiUrl })).map((i) => i.id)).toEqual([5, 6, 11]);
  });

  test("R1.1 install callback sends the user through GitHub sign-in when their token is missing, expired, or revoked", async () => {
    const owner = await ownerWithToken(new Date(NOW.getTime() - HOUR));
    const state = signInstallState(TEST_SECRET, owner.org.id, NOW.getTime(), owner.user.id);
    const url = callbackUrl(state, 11);
    const expectedReauth = `https://review.example.com/api/auth/github?next=${encodeURIComponent(url.slice(config.appUrl.length))}`;

    const gh = fakeGitHub({ installations: [11] });
    const expired = await callbackHandler(gh)(new Request(url, { headers: { cookie: owner.cookie } }));
    expect(expired.headers.get("location")).toBe(expectedReauth);
    expect(gh.calls).toEqual([]);
    expect(await getUserGitHubToken(db, owner.user.id, NOW)).toBeNull();

    // No GitHub identity at all (e.g. a dev-login user).
    const dev = await userWithOrg(db, { login: "devon" });
    const devState = signInstallState(TEST_SECRET, dev.org.id, NOW.getTime(), dev.user.id);
    const noToken = await callbackHandler(gh)(new Request(callbackUrl(devState, 11), { headers: { cookie: dev.cookie } }));
    expect(new URL(noToken.headers.get("location")!).pathname).toBe("/api/auth/github");

    // GitHub rejects a token that looked valid: it is forgotten and the user re-authorizes.
    await db.update(authAccounts).set({ accessTokenExpiresAt: null });
    expect(await getUserGitHubToken(db, owner.user.id, NOW)).toBe(USER_TOKEN);
    const revoked = await callbackHandler(fakeGitHub({ installationsStatus: 401 }))(new Request(url, { headers: { cookie: owner.cookie } }));
    expect(revoked.headers.get("location")).toBe(expectedReauth);
    expect(await getUserGitHubToken(db, owner.user.id, NOW)).toBeNull();

    const unavailable = await ownerWithTokenFor("ursula");
    const down = await callbackHandler(fakeGitHub({ installationsStatus: 502 }))(
      new Request(callbackUrl(unavailable.state, 11), { headers: { cookie: unavailable.cookie } }),
    );
    expect(outcome(down)).toBe("github_unavailable");
    expect(await listInstallations(db, owner.org.id)).toEqual([]);
  });

  test("R1.1 install callback rejects state minted for another user or org, and members without repos.manage", async () => {
    const owner = await ownerWithToken();
    const other = await userWithOrg(db, { login: "oscar", orgName: "Other", githubToken: { token: USER_TOKEN, expiresAt: null } });
    const gh = fakeGitHub({ installations: [11, 22] });
    const run = (state: string, cookie: string) => callbackHandler(gh)(new Request(callbackUrl(state, 11), { headers: { cookie } }));

    expect(outcome(await run(signInstallState(TEST_SECRET, other.org.id, NOW.getTime(), owner.user.id), owner.cookie))).toBe("invalid_state");
    expect(outcome(await run(signInstallState(TEST_SECRET, owner.org.id, NOW.getTime(), other.user.id), owner.cookie))).toBe("invalid_state");
    expect(outcome(await run(signInstallState(TEST_SECRET, owner.org.id, NOW.getTime()), owner.cookie))).toBe("invalid_state");
    expect(outcome(await run(signInstallState("some-other-secret-00000", owner.org.id, NOW.getTime(), owner.user.id), owner.cookie))).toBe("invalid_state");
    expect(outcome(await run(signInstallState(TEST_SECRET, owner.org.id, NOW.getTime() - 2 * HOUR, owner.user.id), owner.cookie))).toBe("invalid_state");

    const member = await makeUser(db, "mae");
    await addMember(db, owner.org.id, member.id, "member");
    const memberCookie = (await signedInCookie(db, member.id, owner.org.id)).cookie;
    expect(outcome(await run(signInstallState(TEST_SECRET, owner.org.id, NOW.getTime(), member.id), memberCookie))).toBe("forbidden");

    const missing = await callbackHandler(gh)(
      new Request(callbackUrl(signInstallState(TEST_SECRET, owner.org.id, NOW.getTime(), owner.user.id), "abc"), { headers: { cookie: owner.cookie } }),
    );
    expect(outcome(missing)).toBe("missing_installation");
    const requested = await callbackHandler(gh)(new Request(`${config.appUrl}/api/github/callback?setup_action=request`, { headers: { cookie: owner.cookie } }));
    expect(outcome(requested)).toBe("requested");
    const anon = await callbackHandler(gh)(new Request(callbackUrl("x", 11)));
    expect(new URL(anon.headers.get("location")!).pathname).toBe("/sign-in");
    expect(gh.calls).toEqual([]);
    expect(await listInstallations(db, owner.org.id)).toEqual([]);
    expect(await listInstallations(db, other.org.id)).toEqual([]);
  });
});

async function ownerWithTokenFor(login: string) {
  const u = await userWithOrg(db, { login, githubToken: { token: USER_TOKEN, expiresAt: null } });
  return { ...u, state: signInstallState(TEST_SECRET, u.org.id, NOW.getTime(), u.user.id) };
}
