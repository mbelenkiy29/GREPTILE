import { and, eq } from "drizzle-orm";
import { BitbucketHost, bitbucketRepoId } from "@/lib/bitbucket/client";
import { installations, repos, scmWebhooks } from "@/lib/db/schema";
import { GitLabHost } from "@/lib/gitlab/client";
import { MemoryQueue } from "@/lib/jobs/types";
import { bitbucketConnection, gitlabConnection } from "@/lib/scm/connection";
import { connectBitbucket, connectGitLab, enableConnectionRepo, type ScmDeps } from "@/lib/scm/connections";
import { FakeBitbucket, FakeGitLab, type ScmWorld } from "./fake-scm";
import { reviewFixture } from "./review-fixture";

export const APP_URL = "https://openreview.example";
export const PROJECT_ID = 42;
export const BB_REPO_UUID = "{1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d}";

/** The fixture's PR #7 as a provider-neutral world for the fake GitLab / Bitbucket APIs. */
export function worldFrom(fx: Awaited<ReturnType<typeof reviewFixture>>): ScmWorld {
  const pr = fx.host.prs.get("acme/shop#7")!;
  return {
    repo: "acme/shop",
    defaultBranch: "main",
    pr: { number: 7, title: pr.pr.title, body: pr.pr.body, author: pr.pr.author, base: fx.base, head: fx.head, sourceBranch: "feature", targetBranch: "main" },
    files: pr.files.map((f) => ({ path: f.path, status: f.status as "modified", patch: f.patch ?? "" })),
    contentAt: (ref, path) => fx.host.contentAt!("acme/shop", path, ref),
    treeAt: (ref) => fx.host.treeAt!("acme/shop", ref),
    compareAt: (base, head) => fx.host.compareAt!("acme/shop", base, head) as { path: string; status: "modified" }[],
    commits: [{ sha: fx.head, message: "add tax", author: "dev", date: "2026-10-01T09:00:00Z" }],
    approvals: ["maria"],
    checks: [{ name: "ci", ok: true }],
  };
}

export function scmDeps(db: ScmDeps["db"], opts: { gitlab?: FakeGitLab; bitbucket?: FakeBitbucket; queue?: MemoryQueue } = {}): ScmDeps & { queue: MemoryQueue } {
  const gl = opts.gitlab ?? new FakeGitLab();
  const bb = opts.bitbucket ?? new FakeBitbucket();
  return {
    db,
    gitlab: new GitLabHost({ credentials: (id) => gitlabConnection(db, id), fetch: gl.fetch, sleep: async () => {} }),
    bitbucket: new BitbucketHost({ credentials: (id) => bitbucketConnection(db, id), fetch: bb.fetch, sleep: async () => {} }),
    queue: opts.queue ?? new MemoryQueue(),
    appUrl: APP_URL,
    gitlabUrl: gl.baseUrl,
    bitbucketApiUrl: bb.apiUrl,
    resolve: async () => ["93.184.216.34"],
  };
}

/**
 * The indexed review fixture moved onto a GitLab or Bitbucket connection: the org connects the provider, the fixture's
 * repository becomes that connection's repository (keeping its index), and enabling it creates the webhook.
 */
export async function scmFixture(provider: "gitlab" | "bitbucket") {
  const fx = await reviewFixture();
  const world = worldFrom(fx);
  const gitlab = new FakeGitLab();
  const bitbucket = new FakeBitbucket();
  if (provider === "gitlab") gitlab.seed(world, PROJECT_ID);
  else bitbucket.seed(world, BB_REPO_UUID);
  const deps = scmDeps(fx.db, { gitlab, bitbucket });
  const created =
    provider === "gitlab"
      ? await connectGitLab(deps, { orgId: "org_a", userId: null, baseUrl: gitlab.baseUrl, token: gitlab.token })
      : await connectBitbucket(deps, { orgId: "org_a", userId: null, workspace: bitbucket.workspace, token: bitbucket.token });
  const externalId = provider === "gitlab" ? PROJECT_ID : bitbucketRepoId(BB_REPO_UUID);
  await fx.db.update(repos).set({ installationId: created.installationId, externalId }).where(eq(repos.id, fx.repo.id));
  const repo = await enableConnectionRepo(deps, "org_a", created.credentialId, externalId);
  const [installation] = await fx.db.select().from(installations).where(eq(installations.id, created.installationId));
  const [hook] = await fx.db.select().from(scmWebhooks).where(and(eq(scmWebhooks.repoId, fx.repo.id)));
  const host = provider === "gitlab" ? deps.gitlab : deps.bitbucket;
  return { fx, world, gitlab, bitbucket, deps, created, repo: repo!, installation: installation!, hook: hook!, host, client: host.client(created.credentialId) };
}
