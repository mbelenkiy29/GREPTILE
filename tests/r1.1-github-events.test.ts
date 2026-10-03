import { beforeEach, describe, expect, test } from "vitest";
import {
  InstallationOwnershipError,
  PendingInstallationNotFoundError,
  REQUIRED_PERMISSIONS,
  claimPendingInstallation,
  completeInstallation,
  getInstallationHealth,
  getPendingInstallation,
  getRepo,
  listInstallations,
  listPendingInstallations,
  listRepos,
  missingPermissions,
  setRepoEnabled,
} from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { GitHubHost } from "@/lib/github/client";
import { MemoryQueue } from "@/lib/jobs/types";
import { FakeLlm } from "@/lib/llm/fake";
import { setLogSink } from "@/lib/log";
import { runReviewJob } from "@/lib/review/run";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { createTestDb } from "./helpers/db";
import { FULL_PERMISSIONS, FakeGitHost } from "./helpers/fake-git";

const SECRET = "whsec_test";
let db: Db;
let host: FakeGitHost;
let queue: MemoryQueue;
let seq = 0;

function send(event: string, payload: object) {
  const handler = createGitHubWebhookHandler(() => ({ db, queue, host, secret: SECRET, botMention: "openreview" }));
  const body = JSON.stringify(payload);
  return handler(
    new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      body,
      headers: { "x-github-event": event, "x-github-delivery": `d-${++seq}`, "x-hub-signature-256": signGitHubPayload(SECRET, body) },
    }),
  ).then((r) => r.json());
}

const installationEvent = (action: string, id: number, extra: object = {}) => ({
  action,
  installation: {
    id,
    account: { login: "initech", type: "Organization" },
    permissions: { ...FULL_PERMISSIONS },
    repository_selection: "selected",
    ...extra,
  },
  sender: { login: "peter", id: 501, type: "User" },
});

const repoEvent = (action: string, repository: object, extra: object = {}) => ({
  action,
  installation: { id: 11 },
  repository: { id: 1, full_name: "acme/api", default_branch: "main", private: true, ...repository },
  sender: { login: "admin", type: "User" },
  ...extra,
});

/** Captures warnings logged while `fn` runs. */
async function warnings(fn: () => Promise<unknown>) {
  const lines: Record<string, unknown>[] = [];
  const restore = setLogSink((line, level) => {
    if (level === "warn") lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  try {
    await fn();
  } finally {
    restore();
  }
  return lines;
}

beforeEach(async () => {
  db = await createTestDb();
  queue = new MemoryQueue();
  host = new FakeGitHost();
  host.addInstallation(11, "acme", [
    { id: 1, fullName: "acme/api", defaultBranch: "main", private: true },
    { id: 2, fullName: "acme/web", defaultBranch: "main", private: false },
  ]);
  host.addInstallation(22, "globex", [{ id: 3, fullName: "globex/core", defaultBranch: "main", private: true }]);
  host.addInstallation(33, "initech", [{ id: 4, fullName: "initech/tps", defaultBranch: "main", private: true }]);
  await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
  await completeInstallation(db, host, { orgId: "org_b", orgName: "Globex", installationId: 22 });
});

describe("GitHub App installation lifecycle", () => {
  test("R1.1 an installation nobody linked yet is kept pending and can be claimed by one org", async () => {
    expect(await send("installation", installationEvent("created", 33))).toEqual({ status: "accepted", jobs: [] });
    expect(await getPendingInstallation(db, "github", 33)).toMatchObject({
      externalId: 33,
      accountLogin: "initech",
      accountType: "Organization",
      senderLogin: "peter",
      senderId: 501,
      repositorySelection: "selected",
      permissions: FULL_PERMISSIONS,
    });
    expect((await listPendingInstallations(db, [11, 22, 33])).map((p) => p.externalId)).toEqual([33]);

    const claimed = await claimPendingInstallation(db, host, { orgId: "org_c", orgName: "Initech", installationId: 33 });
    expect(claimed.installation).toMatchObject({ orgId: "org_c", externalId: 33, accountLogin: "initech", accountType: "Organization" });
    expect(claimed.repos.map((r) => [r.fullName, r.orgId])).toEqual([["initech/tps", "org_c"]]);
    expect(await getPendingInstallation(db, "github", 33)).toBeUndefined();
    expect(await listPendingInstallations(db, [33])).toEqual([]);

    // Claiming again is a refresh for the same org, a conflict for another, and unknown ids are rejected.
    await expect(claimPendingInstallation(db, host, { orgId: "org_c", orgName: "Initech", installationId: 33 })).resolves.toBeTruthy();
    await expect(claimPendingInstallation(db, host, { orgId: "org_d", orgName: "Intruder", installationId: 33 })).rejects.toBeInstanceOf(
      InstallationOwnershipError,
    );
    await expect(claimPendingInstallation(db, host, { orgId: "org_d", orgName: "Intruder", installationId: 99 })).rejects.toBeInstanceOf(
      PendingInstallationNotFoundError,
    );
    expect(await listInstallations(db, "org_d")).toEqual([]);

    // A created event for an installation the setup callback already linked refreshes it instead of going pending.
    expect(await send("installation", installationEvent("created", 33))).toMatchObject({ status: "accepted" });
    expect(await getPendingInstallation(db, "github", 33)).toBeUndefined();
  });

  test("R1.1 uninstalling removes a pending installation or a linked one with its repos", async () => {
    await send("installation", installationEvent("created", 33));
    await send("installation", installationEvent("new_permissions_accepted", 33, { permissions: { metadata: "read" } }));
    expect((await getPendingInstallation(db, "github", 33))?.permissions).toEqual({ metadata: "read" });
    await send("installation", installationEvent("deleted", 33));
    expect(await getPendingInstallation(db, "github", 33)).toBeUndefined();

    await send("installation", installationEvent("suspend", 11));
    expect((await listInstallations(db, "org_a"))[0]?.suspended).toBe(true);
    await send("installation", installationEvent("unsuspend", 11));
    expect((await listInstallations(db, "org_a"))[0]?.suspended).toBe(false);
    await send("installation", installationEvent("deleted", 11));
    expect(await listInstallations(db, "org_a")).toEqual([]);
    expect(await listRepos(db, "org_a")).toEqual([]);
    expect((await listRepos(db, "org_b")).map((r) => r.fullName)).toEqual(["globex/core"]);
  });

  test("R1.1 permissions are validated on install and when new permissions are accepted", async () => {
    expect(REQUIRED_PERMISSIONS).toEqual({ metadata: "read", contents: "read", pull_requests: "write", issues: "write" });
    expect(missingPermissions({ metadata: "read", contents: "write", pull_requests: "admin", issues: "write" })).toEqual([]);
    expect(missingPermissions({ metadata: "read", pull_requests: "read" })).toEqual(["contents:read", "pull_requests:write", "issues:write"]);

    host.addInstallation(44, "hooli", [], { permissions: { metadata: "read", contents: "read", pull_requests: "read", issues: "write" } });
    const logged = await warnings(() => completeInstallation(db, host, { orgId: "org_h", orgName: "Hooli", installationId: 44 }));
    expect(logged).toEqual([
      expect.objectContaining({ msg: "installation is missing required permissions", orgId: "org_h", installationId: 44, missing: ["pull_requests:write"] }),
    ]);
    expect(await getInstallationHealth(db, "org_h")).toEqual([
      expect.objectContaining({
        externalId: 44,
        status: "missing_permissions",
        permissionsVerified: true,
        missingPermissions: ["pull_requests:write"],
        missingRecommended: ["checks:read"],
      }),
    ]);

    // The owner accepts the new permissions on GitHub; the webhook carries them.
    await send("installation", installationEvent("new_permissions_accepted", 44, { permissions: { ...FULL_PERMISSIONS } }));
    expect(await getInstallationHealth(db, "org_h")).toEqual([
      expect.objectContaining({ status: "ok", missingPermissions: [], missingRecommended: [] }),
    ]);

    // Without permissions in the payload they are fetched from GitHub.
    host.addInstallation(44, "hooli", [], { permissions: { metadata: "read", contents: "read", pull_requests: "write" } });
    await send("installation", { action: "new_permissions_accepted", installation: { id: 44 } });
    expect((await getInstallationHealth(db, "org_h"))[0]).toMatchObject({ status: "missing_permissions", missingPermissions: ["issues:write"] });
    // Health is tenant-scoped.
    expect((await getInstallationHealth(db, "org_a")).map((i) => i.externalId)).toEqual([11]);
  });
});

describe("repository events", () => {
  test("R1.1 renamed, transferred, and deleted repositories are mirrored", async () => {
    await send("repository", repoEvent("renamed", { full_name: "acme/api-v2" }, { changes: { repository: { name: { from: "api" } } } }));
    expect((await listRepos(db, "org_a")).map((r) => r.fullName)).toEqual(["acme/api-v2", "acme/web"]);

    await send("repository", repoEvent("transferred", { full_name: "acme-labs/api-v2" }));
    expect((await listRepos(db, "org_a")).map((r) => r.fullName).sort()).toEqual(["acme-labs/api-v2", "acme/web"]);

    // Transferred in from elsewhere: the installation now has access, so a resync picks it up and indexes it.
    host.addInstallation(11, "acme", [
      { id: 1, fullName: "acme-labs/api-v2", defaultBranch: "main", private: true },
      { id: 2, fullName: "acme/web", defaultBranch: "main", private: false },
      { id: 9, fullName: "acme/imported", defaultBranch: "main", private: true },
    ]);
    const imported = await send("repository", repoEvent("transferred", { id: 9, full_name: "acme/imported" }));
    const importedRow = (await listRepos(db, "org_a")).find((r) => r.fullName === "acme/imported")!;
    expect(imported).toEqual({ status: "accepted", jobs: expect.arrayContaining([`index-${importedRow.id}-initial`]) });

    expect(await send("repository", repoEvent("deleted", { id: 2, full_name: "acme/web" }))).toEqual({ status: "accepted", jobs: [] });
    expect((await listRepos(db, "org_a")).map((r) => r.fullName).sort()).toEqual(["acme-labs/api-v2", "acme/imported"]);
    // Another org's installation cannot touch org_a's repository.
    const foreign = await send("repository", { ...repoEvent("deleted", { id: 1 }), installation: { id: 22 } });
    expect(foreign).toEqual({ status: "ignored", reason: "repository not connected" });
    expect((await listRepos(db, "org_a")).map((r) => r.externalId)).toContain(1);
  });

  test("R1.1 archived repositories are never reviewed and unarchiving does not re-enable them", async () => {
    const repo = (await listRepos(db, "org_a")).find((r) => r.externalId === 1)!;
    await send("repository", repoEvent("archived", { archived: true }));
    expect(await getRepo(db, "org_a", repo.id)).toMatchObject({ archived: true, enabled: false });

    // Even if someone turns reviews back on, an archived repo is skipped by the webhook and the review job.
    await setRepoEnabled(db, "org_a", repo.id, true);
    const pr = { action: "opened", installation: { id: 11 }, repository: { id: 1 }, pull_request: { number: 3, head: { sha: "s1" } } };
    expect(await send("pull_request", pr)).toEqual({ status: "ignored", reason: "repository archived" });
    const skipped = await runReviewJob({ db, host, llm: new FakeLlm() }, { orgId: "org_a", repoId: repo.id, prNumber: 3, headSha: "s1" });
    expect(skipped).toMatchObject({ status: "skipped", reason: "repository archived" });

    await setRepoEnabled(db, "org_a", repo.id, false);
    await send("repository", repoEvent("unarchived", { archived: false }));
    expect(await getRepo(db, "org_a", repo.id)).toMatchObject({ archived: false, enabled: false });
    expect(await send("pull_request", pr)).toEqual({ status: "ignored", reason: "reviews disabled for repository" });

    // Suspended installations are not reviewed either.
    await setRepoEnabled(db, "org_a", repo.id, true);
    await send("installation", installationEvent("suspend", 11));
    expect(await send("pull_request", pr)).toEqual({ status: "ignored", reason: "installation suspended" });
    expect(queue.jobs.filter((j) => j.name === "review-pr")).toEqual([]);
  });

  test("R1.1 default branch and visibility changes are mirrored", async () => {
    const repo = (await listRepos(db, "org_a")).find((r) => r.externalId === 1)!;
    const res = await send("repository", repoEvent("edited", { default_branch: "trunk" }, { changes: { default_branch: { from: "main" } } }));
    expect(await getRepo(db, "org_a", repo.id)).toMatchObject({ defaultBranch: "trunk" });
    expect(res).toEqual({ status: "accepted", jobs: [`index-${repo.id}-branch-d-${seq}`] });
    expect(queue.jobs.at(-1)?.data).toMatchObject({ repoId: repo.id, mode: "full", trigger: "default_branch" });

    expect(await send("repository", repoEvent("edited", { description: "x" }, { changes: { description: { from: "" } } }))).toEqual({
      status: "ignored",
      reason: "repository.edited without a default branch change",
    });

    await send("repository", repoEvent("publicized", { private: false }));
    expect((await getRepo(db, "org_a", repo.id))?.private).toBe(false);
    await send("repository", repoEvent("privatized", { private: true }));
    expect((await getRepo(db, "org_a", repo.id))?.private).toBe(true);

    // A push payload names the current default branch, so a missed edit is caught up.
    const push = await send("push", {
      ref: "refs/heads/develop",
      after: "a1",
      installation: { id: 11 },
      repository: { id: 1, full_name: "acme/api", default_branch: "develop" },
    });
    expect(push).toEqual({ status: "accepted", jobs: [`index-${repo.id}-a1`] });
    expect((await getRepo(db, "org_a", repo.id))?.defaultBranch).toBe("develop");
  });

  test("R1.1 GitHub Enterprise: clone URLs derive from the configured web origin", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ token: "ghs_enterprise_token_value", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const ghe = new GitHubHost({
      appId: "1",
      privateKey: (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiUrl: "https://ghe.example.com/api/v3/",
      webUrl: "https://ghe.example.com/",
      fetch: fetchImpl,
    });
    expect(await ghe.client(7).cloneUrl("acme/api")).toBe("https://x-access-token:ghs_enterprise_token_value@ghe.example.com/acme/api.git");
    const dotcom = new GitHubHost({ appId: "1", privateKey: "unused", fetch: fetchImpl });
    expect(dotcom.webUrl).toBe("https://github.com");
    expect(dotcom.apiUrl).toBe("https://api.github.com");
  });
});
