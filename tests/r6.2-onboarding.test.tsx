import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { RepoProgressRow } from "@/components/onboarding/IndexProgressList";
import { AdminOnly, ConfigureStep, InstallStep, OnboardingStepper, ReadyStep, RepoSelectStep, WorkspaceStep } from "@/components/onboarding/Steps";
import { createInstallCallbackHandler, createInstallStartHandler } from "@/lib/auth/install";
import { saveOrgSettingsForm } from "@/lib/config/settings-form";
import { SETTING_DEFAULTS } from "@/lib/config/settings";
import { listInstallations, storePendingInstallation } from "@/lib/data/installations";
import {
  canViewStep,
  completeOnboarding,
  connectPendingInstallation,
  createIndexStatusHandler,
  deriveOnboarding,
  getOnboardingState,
  listClaimableInstallations,
  needsOnboarding,
  requestManualReview,
  setEnabledRepos,
  type OnboardingFacts,
} from "@/lib/data/onboarding";
import type { Db } from "@/lib/db";
import { indexJobs, installations, orgs, repos } from "@/lib/db/schema";
import { verifyInstallState, signInstallState } from "@/lib/github/install-state";
import { MemoryQueue } from "@/lib/jobs/types";
import { githubInstallationSettingsUrl } from "@/lib/ui/format";
import { addMember, fakeGitHub, makeUser, NOW, signedInCookie, TEST_SECRET, testAuthConfig, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";

const TOKEN = "ghu_onboarding0000000000000000000000000";
const clock = { now: NOW, ttlDays: testAuthConfig.sessionTtlDays };
let db: Db;
let host: FakeGitHost;
let ext = 80_000;

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
  host = new FakeGitHost();
  host.addInstallation(31, "acme", [
    { id: 1, fullName: "acme/api", defaultBranch: "main", private: true },
    { id: 2, fullName: "acme/web", defaultBranch: "main", private: false },
  ]);
  host.addInstallation(32, "globex", [{ id: 3, fullName: "globex/core", defaultBranch: "main", private: true }]);
});

afterEach(() => vi.unstubAllEnvs());

async function owner(login = "olive") {
  return userWithOrg(db, { login, githubToken: { token: TOKEN, expiresAt: null } });
}

async function addRepos(orgId: string, names: string[], extra: Partial<typeof repos.$inferInsert> = {}) {
  const [inst] = await db.insert(installations).values({ orgId, externalId: ++ext, accountLogin: "acct" }).returning();
  const out = [];
  for (const fullName of names) {
    const [r] = await db.insert(repos).values({ orgId, installationId: inst!.id, externalId: ++ext, fullName, ...extra }).returning();
    out.push(r!);
  }
  return out;
}

const pending = (externalId: number, accountLogin: string) =>
  storePendingInstallation(db, "github", { externalId, accountLogin, accountType: "Organization", senderLogin: "olive", repositorySelection: "selected" });

/** The `<input>` tag of rendered markup that contains `attr`. */
function input(html: string, attr: string): string {
  return (html.match(/<input[^>]*>/g) ?? []).find((t) => t.includes(attr)) ?? "";
}

function form(values: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

describe("onboarding wizard", () => {
  test("R6.2 wizard state is derived per step from the org's data and resumes at the first unfinished step", async () => {
    const facts: OnboardingFacts = { hasOrg: true, installations: 0, repos: 0, enabledRepos: 0, indexedRepos: 0, configured: false, completedAt: null };
    expect(deriveOnboarding({ ...facts, hasOrg: false }).current).toBe("workspace");
    expect(deriveOnboarding(facts).current).toBe("install");
    expect(deriveOnboarding({ ...facts, installations: 1, repos: 2 }).current).toBe("repos");
    expect(deriveOnboarding({ ...facts, installations: 1, repos: 2, enabledRepos: 1 }).current).toBe("configure");
    expect(deriveOnboarding({ ...facts, installations: 1, repos: 2, enabledRepos: 1, configured: true }).current).toBe("indexing");
    expect(deriveOnboarding({ ...facts, installations: 1, repos: 2, enabledRepos: 1, indexedRepos: 1, configured: true }).current).toBe("ready");
    // Indexing never blocks finishing: "ready" can be opened while it runs; later steps can't be skipped to.
    const indexing = deriveOnboarding({ ...facts, installations: 1, repos: 2, enabledRepos: 1, configured: true });
    expect(canViewStep(indexing, "ready")).toBe(true);
    expect(canViewStep(indexing, "repos")).toBe(true);
    expect(canViewStep(deriveOnboarding(facts), "configure")).toBe(false);
    expect(canViewStep(deriveOnboarding({ ...facts, hasOrg: false }), "install")).toBe(false);
    const done = deriveOnboarding({ ...facts, installations: 1, repos: 2, enabledRepos: 1, indexedRepos: 1, configured: true, completedAt: NOW });
    expect(done.steps.every((s) => s.done)).toBe(true);

    const o = await owner();
    expect((await getOnboardingState(db, null)).current).toBe("workspace");
    expect((await getOnboardingState(db, o.org.id)).current).toBe("install");
    expect(await needsOnboarding(db, o.org.id)).toBe(true);
    const [api] = await addRepos(o.org.id, ["acme/api"], { enabled: false });
    expect((await getOnboardingState(db, o.org.id)).current).toBe("repos");
    await setEnabledRepos(db, o.org.id, [api!.id]);
    expect((await getOnboardingState(db, o.org.id)).current).toBe("configure");
    await saveOrgSettingsForm(db, { orgId: o.org.id, role: "owner" }, form({ mode: "fast" }), { merge: true });
    expect((await getOnboardingState(db, o.org.id)).current).toBe("indexing");
    await db.update(repos).set({ indexStatus: "ready" }).where(eq(repos.id, api!.id));
    const ready = await getOnboardingState(db, o.org.id);
    expect(ready).toMatchObject({ current: "ready", enabledRepos: 1, indexedRepos: 1, configured: true });
    // An org with an installation no longer sends sign-in to the wizard; finishing marks the last step done.
    expect(await needsOnboarding(db, o.org.id)).toBe(false);
    await completeOnboarding(db, o.org.id, NOW);
    expect((await getOnboardingState(db, o.org.id)).steps.find((s) => s.id === "ready")?.done).toBe(true);
    const [row] = await db.select({ at: orgs.onboardingCompletedAt }).from(orgs).where(eq(orgs.id, o.org.id));
    expect(row?.at?.toISOString()).toBe(NOW.toISOString());
  });

  test("R6.2 a pending installation is offered and claimed only when the signed-in user can access it on GitHub", async () => {
    const o = await owner();
    await pending(31, "acme");
    await pending(32, "globex");
    const gh = fakeGitHub({ installations: [31, 77] });
    const deps = { db, fetch: gh.fetch, apiUrl: testAuthConfig.githubApiUrl, now: NOW };

    const claimable = await listClaimableInstallations(deps, o.user.id);
    expect(claimable.status === "ok" && claimable.installations.map((i) => i.externalId)).toEqual([31]);
    expect(gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);

    const enqueued: string[][] = [];
    const connect = (ctx: { orgId: string; orgName: string; userId: string; role: "owner" | "admin" | "member" }, id: number) =>
      connectPendingInstallation({ ...deps, host, enqueue: async (rows) => enqueued.push(rows.map((r) => r.fullName)) }, ctx, id);
    const ctx = { orgId: o.org.id, orgName: o.org.name, userId: o.user.id, role: "owner" as const };

    // Not visible to this user on GitHub: refused, nothing linked.
    expect(await connect(ctx, 32)).toEqual({ status: "not_accessible" });
    expect(await listInstallations(db, o.org.id)).toEqual([]);
    // Members cannot connect installations at all.
    const member = await makeUser(db, "mia");
    await addMember(db, o.org.id, member.id, "member");
    expect(await connect({ ...ctx, userId: member.id, role: "member" }, 31)).toEqual({ status: "forbidden" });
    // No stored GitHub token: the user must sign in with GitHub again.
    const noToken = await userWithOrg(db, { login: "nate" });
    expect(await listClaimableInstallations(deps, noToken.user.id)).toEqual({ status: "reauthorize" });
    expect(await connect({ orgId: noToken.org.id, orgName: noToken.org.name, userId: noToken.user.id, role: "owner" }, 31)).toEqual({ status: "reauthorize" });

    expect(await connect(ctx, 31)).toEqual({ status: "connected", repos: 2, missingPermissions: [] });
    expect(enqueued).toEqual([["acme/api", "acme/web"]]);
    expect((await listInstallations(db, o.org.id)).map((i) => i.externalId)).toEqual([31]);
    // Once linked it is no longer pending, so another org's owner who can also see it gets nothing to claim.
    const rival = await userWithOrg(db, { login: "rita", githubToken: { token: TOKEN, expiresAt: null } });
    expect(await listClaimableInstallations(deps, rival.user.id)).toEqual({ status: "ok", installations: [] });
    expect(await connect({ orgId: rival.org.id, orgName: rival.org.name, userId: rival.user.id, role: "owner" }, 31)).toEqual({ status: "owned_elsewhere" });

    // A revoked token is forgotten and the user is asked to sign in again.
    const revoked = fakeGitHub({ installationsStatus: 401 });
    expect(await listClaimableInstallations({ ...deps, fetch: revoked.fetch }, o.user.id)).toEqual({ status: "reauthorize" });
  });

  test("R6.2 the install flow started from onboarding returns to the wizard", async () => {
    const o = await owner();
    const start = createInstallStartHandler(() => ({ db, config: { ...testAuthConfig, appSlug: "openreview-test" }, now: () => NOW }));
    const res = await start(new Request(`${testAuthConfig.appUrl}/api/github/install?from=onboarding`, { headers: { cookie: o.cookie } }));
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    expect(verifyInstallState(TEST_SECRET, state, NOW.getTime())).toEqual({ orgId: o.org.id, userId: o.user.id, returnTo: "onboarding" });

    const gh = fakeGitHub({ installations: [31] });
    const callback = createInstallCallbackHandler(() => ({
      db,
      config: { ...testAuthConfig, appSlug: "openreview-test" },
      host,
      fetch: gh.fetch,
      now: () => NOW,
      enqueue: async () => {},
    }));
    const done = await callback(
      new Request(`${testAuthConfig.appUrl}/api/github/callback?installation_id=31&setup_action=install&state=${encodeURIComponent(state)}`, { headers: { cookie: o.cookie } }),
    );
    expect(done.headers.get("location")).toBe(`${testAuthConfig.appUrl}/onboarding?install=ok`);
    // Without the onboarding marker it returns to the Repositories page as before.
    const plain = signInstallState(TEST_SECRET, o.org.id, NOW.getTime(), o.user.id);
    const again = await callback(
      new Request(`${testAuthConfig.appUrl}/api/github/callback?installation_id=31&setup_action=install&state=${encodeURIComponent(plain)}`, { headers: { cookie: o.cookie } }),
    );
    expect(new URL(again.headers.get("location")!).pathname).toBe("/dashboard/repos");
  });

  test("R6.2 repository selection enables the checked repositories and disables the rest", async () => {
    const o = await owner();
    const other = await owner("otto");
    const [api, web, docs] = await addRepos(o.org.id, ["acme/api", "acme/web", "acme/docs"], { enabled: false });
    const [old] = await addRepos(o.org.id, ["acme/old"], { archived: true, enabled: false });
    const [foreign] = await addRepos(other.org.id, ["otto/x"], { enabled: false });

    const first = await setEnabledRepos(db, o.org.id, [api!.id, web!.id, old!.id, foreign!.id, -1]);
    expect(first.turnedOn.map((r) => r.fullName).sort()).toEqual(["acme/api", "acme/web"]);
    expect(first.enabled).toBe(2);
    const state = async () => Object.fromEntries((await db.select().from(repos)).map((r) => [r.fullName, r.enabled]));
    expect(await state()).toEqual({ "acme/api": true, "acme/web": true, "acme/docs": false, "acme/old": false, "otto/x": false });

    const second = await setEnabledRepos(db, o.org.id, [docs!.id]);
    expect(second).toMatchObject({ turnedOff: 2, enabled: 1 });
    expect(second.turnedOn.map((r) => r.fullName)).toEqual(["acme/docs"]);
    expect(await state()).toEqual({ "acme/api": false, "acme/web": false, "acme/docs": true, "acme/old": false, "otto/x": false });
  });

  test("R6.2 org review defaults from the wizard are saved to orgs.settings (merged) and need settings.manage", async () => {
    const o = await owner();
    await db.update(orgs).set({ settings: { ignore: ["dist/**"] } }).where(eq(orgs.id, o.org.id));
    const wizard = form({ mode: "deep", autoReview: ["false"], reviewDrafts: ["true", "false"], minSeverity: "medium", maxComments: "15", commentStyle: "detailed" });

    expect((await saveOrgSettingsForm(db, { orgId: o.org.id, role: "member" }, wizard, { merge: true })).status).toBe("forbidden");
    const bad = await saveOrgSettingsForm(db, { orgId: o.org.id, role: "admin" }, form({ maxComments: "500" }), { merge: true });
    expect(bad).toMatchObject({ status: "invalid", errors: { maxComments: expect.any(String) } });
    expect((await saveOrgSettingsForm(db, { orgId: o.org.id, role: "admin" }, wizard, { merge: true })).status).toBe("saved");
    const [row] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, o.org.id));
    expect(row?.settings).toEqual({ ignore: ["dist/**"], mode: "deep", autoReview: false, reviewDrafts: true, minSeverity: "medium", maxComments: 15, commentStyle: "detailed" });
    // The full Settings form replaces the layer.
    expect((await saveOrgSettingsForm(db, { orgId: o.org.id, role: "owner" }, form({ mode: "fast" }))).status).toBe("saved");
    expect((await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, o.org.id)))[0]?.settings).toEqual({ mode: "fast" });
  });

  test("R6.2 the index-status endpoint requires sign-in and returns only the session org's enabled repositories", async () => {
    const o = await owner();
    const other = await owner("otto");
    const [api, web] = await addRepos(o.org.id, ["acme/api", "acme/web"]);
    await addRepos(o.org.id, ["acme/off"], { enabled: false });
    await addRepos(other.org.id, ["otto/secret"]);
    await db.update(repos).set({ indexStatus: "indexing" }).where(eq(repos.id, api!.id));
    await db.update(repos).set({ indexStatus: "failed", indexError: "clone failed" }).where(eq(repos.id, web!.id));
    await db.insert(indexJobs).values({
      orgId: o.org.id,
      repoId: api!.id,
      kind: "full",
      trigger: "install",
      status: "running",
      progress: { phase: "parse", filesTotal: 40, filesDone: 10, filesChanged: 40, filesRemoved: 0, filesSkipped: {}, symbols: 0, edges: 0, secretLinesRedacted: 0 },
    });

    const handler = createIndexStatusHandler(() => ({ db, clock }));
    const url = `${testAuthConfig.appUrl}/api/orgs/current/index-status`;
    expect((await handler(new Request(url))).status).toBe(401);
    const noOrg = await signedInCookie(db, o.user.id, null);
    expect((await handler(new Request(url, { headers: { cookie: noOrg.cookie } }))).status).toBe(403);

    const res = await handler(new Request(url, { headers: { cookie: o.cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { repos: { fullName: string; indexStatus: string; indexError: string | null; job: unknown }[]; settled: boolean };
    expect(body.settled).toBe(false);
    expect(body.repos.map((r) => r.fullName)).toEqual(["acme/api", "acme/web"]);
    expect(body.repos[0]).toMatchObject({ indexStatus: "indexing", job: { status: "running", phase: "parse", filesDone: 10, filesTotal: 40 } });
    expect(body.repos[1]).toMatchObject({ indexStatus: "failed", indexError: "clone failed", job: null });
    expect(JSON.stringify(body)).not.toContain("otto");
  });

  test("R6.2 the ready step requests a manual review of an existing pull request", async () => {
    const o = await owner();
    const other = await owner("otto");
    const [api] = await addRepos(o.org.id, ["acme/api"]);
    const [off] = await addRepos(o.org.id, ["acme/off"], { enabled: false });
    const [foreign] = await addRepos(other.org.id, ["otto/x"]);
    const queue = new MemoryQueue();
    const ctx = { orgId: o.org.id, userId: o.user.id, role: "member" as const };

    expect(await requestManualReview({ db, queue }, ctx, { repoId: String(api!.id), prNumber: "abc" })).toMatchObject({ status: "invalid" });
    expect(await requestManualReview({ db, queue }, ctx, { repoId: String(foreign!.id), prNumber: "4" })).toMatchObject({ status: "not_found" });
    expect(await requestManualReview({ db, queue }, ctx, { repoId: String(off!.id), prNumber: "4" })).toMatchObject({ status: "disabled" });
    expect(queue.jobs).toEqual([]);

    const ok = await requestManualReview({ db, queue }, ctx, { repoId: String(api!.id), prNumber: "42" });
    expect(ok.status).toBe("queued");
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ name: "review-pr", data: { orgId: o.org.id, repoId: api!.id, prNumber: 42, trigger: "manual" } });
  });

  test("R6.2 wizard steps render with a progress stepper, admin-only explanations, and the ready-state actions", () => {
    const action = async () => {};
    const state = deriveOnboarding({ hasOrg: true, installations: 1, repos: 2, enabledRepos: 2, indexedRepos: 0, configured: false, completedAt: null });
    const stepper = renderToStaticMarkup(<OnboardingStepper state={state} viewing="configure" />);
    expect(stepper).toContain('data-state="done" data-step="install"');
    expect(stepper).toContain('data-state="current" data-step="configure"');
    expect(stepper).toContain('aria-current="step"');
    expect(stepper).toContain('href="/onboarding?step=repos"');
    expect(stepper).not.toContain('href="/onboarding?step=ready"');

    const ws = renderToStaticMarkup(
      <WorkspaceStep
        current={null}
        orgs={[{ id: "org_1", name: "Acme", slug: "acme", personal: false, role: "admin" }]}
        invitations={[{ id: 9, orgId: "org_2", orgName: "Globex", email: null, githubLogin: "olive", role: "member", invitedByName: "Gina", createdAt: NOW, expiresAt: NOW }]}
        error={null}
        actions={{ create: action, choose: action, accept: action }}
      />,
    );
    expect(ws).toContain("Globex");
    expect(ws).toContain("Accept and continue");
    expect(ws).toContain("Use this workspace");
    expect(ws).toContain("Create workspace");

    const manageUrl = githubInstallationSettingsUrl({ accountLogin: "acme", accountType: "Organization", externalId: 31 }, "https://github.example");
    expect(manageUrl).toBe("https://github.example/organizations/acme/settings/installations/31");
    const install = renderToStaticMarkup(
      <InstallStep
        canManage
        role="owner"
        installations={[{ id: 1, externalId: 31, accountLogin: "acme", status: "missing_permissions", missingPermissions: ["pull_requests:write"], missingRecommended: [], manageUrl }]}
        claimable={{ status: "ok", installations: [{ id: 1, provider: "github", externalId: 32, accountLogin: "globex", accountType: "Organization", senderLogin: "olive", senderId: null, permissions: {}, repositorySelection: "all", createdAt: NOW }] }}
        message={null}
        connectAction={action}
      />,
    );
    expect(install).toContain('href="/api/github/install?from=onboarding"');
    expect(install).toContain("Missing required permissions");
    expect(install).toContain("pull_requests:write");
    expect(install).toContain("Connect existing installation");
    expect(install).toContain('name="installationId" value="32"');

    const repoStep = renderToStaticMarkup(
      <RepoSelectStep
        canManage
        role="admin"
        groups={[{ installation: { id: 1, accountLogin: "acme", repositorySelection: "selected", manageUrl }, repos: [
          { id: 5, fullName: "acme/api", enabled: true, archived: false, private: true },
          { id: 6, fullName: "acme/old", enabled: false, archived: true, private: false },
        ] }]}
        action={action}
      />,
    );
    expect(repoStep).toContain("Repository access is managed on GitHub");
    expect(repoStep).toContain(`href="${manageUrl}"`);
    expect(input(repoStep, 'value="5"')).toContain('checked=""');
    expect(input(repoStep, 'value="6"')).toContain('disabled=""');
    expect(input(repoStep, 'value="6"')).not.toContain('checked=""');

    const configure = renderToStaticMarkup(<ConfigureStep canManage={false} role="member" defaults={SETTING_DEFAULTS} action={action} />);
    expect(configure).toContain("is set up by an owner or admin");
    expect(configure).toContain("Lowest cost");
    expect(configure).toContain("Highest cost");
    expect(input(configure, 'value="standard"')).toContain('checked=""');
    expect(input(configure, 'value="deep"')).not.toContain('checked=""');
    expect(configure).toContain('<fieldset class="fieldset stack" disabled=""');

    const member = renderToStaticMarkup(<AdminOnly step="install" role="member" />);
    expect(member).toContain("read-only for you");

    const ready = renderToStaticMarkup(
      <ReadyStep repos={[{ id: 5, fullName: "acme/api" }]} canTrigger canFinish reviewError={null} docsUrl="https://example.com/docs" actions={{ review: action, finish: action }} />,
    );
    expect(ready).toContain("Open a pull request in an enabled repository — OpenReview reviews it automatically");
    expect(ready).toContain("Review an existing pull request");
    expect(ready).toContain('name="prNumber"');
    expect(ready).toContain('href="/dashboard/rules"');
    expect(ready).toContain('href="https://example.com/docs"');

    const row = renderToStaticMarkup(
      <RepoProgressRow
        repo={{ repoId: 5, fullName: "acme/api", indexStatus: "failed", indexError: "clone failed", fileCount: 0, job: null }}
        retryAction={action}
      />,
    );
    expect(row).toContain("clone failed");
    expect(row).toContain("Retry");
    const running = renderToStaticMarkup(
      <RepoProgressRow repo={{ repoId: 6, fullName: "acme/web", indexStatus: "indexing", indexError: null, fileCount: 0, job: { id: 1, status: "running", phase: "parse", filesDone: 10, filesTotal: 40, error: null } }} />,
    );
    expect(running).toContain("Parsing · 10 / 40 files");
  });
});
