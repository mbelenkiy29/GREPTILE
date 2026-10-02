import { generateKeyPairSync, createVerify } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import {
  InstallationOwnershipError,
  completeInstallation,
  getRepo,
  listInstallations,
  listRepos,
  setRepoEnabled,
  syncInstallationRepos,
} from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { createAppJwt } from "@/lib/github/app";
import { GitHubHost } from "@/lib/github/client";
import { signInstallState, verifyInstallState } from "@/lib/github/install-state";
import { enqueueIndexForNewRepos } from "@/lib/jobs/enqueue";
import { MemoryQueue } from "@/lib/jobs/types";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";

const SECRET = "test-secret-0123456789";

describe("GitHub App install flow", () => {
  let db: Db;
  let host: FakeGitHost;

  beforeEach(async () => {
    db = await createTestDb();
    host = new FakeGitHost();
    host.addInstallation(11, "acme", [
      { id: 1, fullName: "acme/api", defaultBranch: "main", private: true },
      { id: 2, fullName: "acme/web", defaultBranch: "trunk", private: false },
    ]);
    host.addInstallation(22, "globex", [{ id: 3, fullName: "globex/core", defaultBranch: "main", private: true }]);
  });

  test("R1.1 install state is signed, bound to the org, and rejects tampering or expiry", () => {
    const now = Date.now();
    const state = signInstallState(SECRET, "org_a", now);
    expect(verifyInstallState(SECRET, state, now)).toEqual({ orgId: "org_a" });
    expect(verifyInstallState("another-secret-xxxxxxxx", state, now)).toBeNull();
    const [payload, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ o: "org_b", t: now })).toString("base64url");
    expect(verifyInstallState(SECRET, `${forged}.${sig}`, now)).toBeNull();
    expect(verifyInstallState(SECRET, `${payload}`, now)).toBeNull();
    expect(verifyInstallState(SECRET, state, now + 2 * 60 * 60 * 1000)).toBeNull();
  });

  test("R1.1 completing an install stores the installation and selected repos under the org", async () => {
    const { installation, repos } = await completeInstallation(db, host, {
      orgId: "org_a",
      orgName: "Acme",
      installationId: 11,
    });
    expect(installation).toMatchObject({ orgId: "org_a", externalId: 11, accountLogin: "acme" });
    expect(repos.map((r) => [r.fullName, r.defaultBranch, r.orgId, r.indexStatus])).toEqual([
      ["acme/api", "main", "org_a", "pending"],
      ["acme/web", "trunk", "org_a", "pending"],
    ]);

    const queue = new MemoryQueue();
    await enqueueIndexForNewRepos(repos, queue);
    expect(queue.jobs.map((j) => [j.name, j.data])).toEqual(
      repos.map((r) => ["index-repo", { orgId: "org_a", repoId: r.id, mode: "full" }]),
    );
  });

  test("R1.1 repo selection changes on GitHub are mirrored and can be toggled per repo", async () => {
    const { installation, repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
    await syncInstallationRepos(db, host, installation, [
      { id: 2, fullName: "acme/web", defaultBranch: "trunk", private: false },
      { id: 4, fullName: "acme/cli", defaultBranch: "main", private: true },
    ]);
    expect((await listRepos(db, "org_a")).map((r) => r.fullName)).toEqual(["acme/cli", "acme/web"]);

    const web = repos.find((r) => r.fullName === "acme/web")!;
    expect(await setRepoEnabled(db, "org_a", web.id, false)).toBe(true);
    expect((await getRepo(db, "org_a", web.id))?.enabled).toBe(false);
  });

  test("R1.1 an installation linked to one org cannot be claimed by another", async () => {
    await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
    await expect(
      completeInstallation(db, host, { orgId: "org_b", orgName: "Intruder", installationId: 11 }),
    ).rejects.toBeInstanceOf(InstallationOwnershipError);
    expect(await listInstallations(db, "org_b")).toEqual([]);
  });

  test("R1.1 tenant isolation: one org never reads or mutates another org's rows", async () => {
    const a = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
    const b = await completeInstallation(db, host, { orgId: "org_b", orgName: "Globex", installationId: 22 });
    const bRepo = b.repos[0]!;

    expect((await listRepos(db, "org_a")).every((r) => r.orgId === "org_a")).toBe(true);
    expect((await listRepos(db, "org_b")).map((r) => r.fullName)).toEqual(["globex/core"]);
    expect(await getRepo(db, "org_a", bRepo.id)).toBeUndefined();
    expect(await setRepoEnabled(db, "org_a", bRepo.id, false)).toBe(false);
    expect((await getRepo(db, "org_b", bRepo.id))?.enabled).toBe(true);
    expect((await listInstallations(db, "org_a")).map((i) => i.id)).toEqual([a.installation.id]);
    await expect(listRepos(db, "")).rejects.toThrow(/orgId/);
  });

  test("R1.1 GitHub App JWT is RS256-signed by the app and exchanged for an installation token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = createAppJwt("12345", pem, 1_700_000_000_000);
    const [h, p, s] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "12345" });

    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: "ghs_inst", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return Response.json({ repositories: [{ id: 9, full_name: "acme/api", default_branch: "main", private: true }] });
    };
    const gh = new GitHubHost({ appId: "12345", privateKey: pem.replace(/\n/g, "\\n"), fetch: fetchImpl });
    expect(await gh.listInstallationRepos(11)).toEqual([{ id: 9, fullName: "acme/api", defaultBranch: "main", private: true }]);
    await gh.listInstallationRepos(11);
    expect(calls.filter((c) => c.url.endsWith("/app/installations/11/access_tokens"))).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ url: "https://api.github.com/installation/repositories?per_page=100", auth: "Bearer ghs_inst" });
  });
});
