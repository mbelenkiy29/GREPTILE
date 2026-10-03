import { eq } from "drizzle-orm";
import { completeInstallation } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { reviewRuns } from "@/lib/db/schema";
import { MemoryQueue } from "@/lib/jobs/types";
import { FakeLlm } from "@/lib/llm/fake";
import type { RunReview } from "@/lib/pipeline/engine";
import { requestReview, type RequestReviewInput } from "@/lib/pipeline/request";
import { runReviewJob, type ReviewJobDeps } from "@/lib/review/run";
import { createTestDb } from "./db";
import { FakeGitHost } from "./fake-git";
import { FixtureRepo } from "./fixture-repo";
import { addPrFromFixture } from "./pr";
import { BASE_FILES, HEAD_PRICING } from "./review-fixture";

export const PRICING = "services/billing/pricing.ts";

/**
 * A connected repo with PR #7 on a fake host, without indexing (for pipeline tests that use a stub engine).
 * `push()` adds a commit to the PR; `review()` requests a run and executes its job.
 */
export async function pipelineFixture(opts: { baseExtra?: Record<string, string> } = {}) {
  const db: Db = await createTestDb();
  const fixture = new FixtureRepo();
  const base = fixture.commit({ ...BASE_FILES, ...opts.baseExtra }, "base");
  const host = new FakeGitHost();
  host.treeAt = (_repo, ref) => fixture.git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
  host.contentAt = (_repo, path, ref) => {
    try {
      return fixture.git("show", `${ref}:${path}`) + "\n";
    } catch {
      return null;
    }
  };
  host.compareAt = (_repo, from, to) =>
    fixture
      .git("diff", "--name-status", from, to)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [, path] = line.split("\t") as [string, string];
        return { path, status: "modified" as const };
      });
  host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/shop", defaultBranch: "main", private: true }]);
  const { repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
  const repo = repos[0]!;
  fixture.git("checkout", "--quiet", "-b", "feature");
  const head = fixture.commit({ [PRICING]: HEAD_PRICING }, "add tax");
  const pr = addPrFromFixture(host, fixture, "acme/shop", { number: 7, base, head, title: "Add tax to totals", author: "dana" });
  const queue = new MemoryQueue();
  const llm = new FakeLlm(() => ({}));

  const deps = (engine: RunReview, extra: Partial<ReviewJobDeps> = {}): ReviewJobDeps => ({ db, host, llm, queue, runReview: engine, ...extra });

  /** Adds a commit to PR #7 and makes it the PR head. */
  const push = (files: Record<string, string>, opts2: { draft?: boolean } = {}) => {
    const sha = fixture.commit(files, "push");
    const next = addPrFromFixture(host, fixture, "acme/shop", { number: 7, base, head: sha, title: "Add tax to totals", author: "dana" });
    if (opts2.draft) next.draft = true;
    return sha;
  };

  /** Requests a run and runs its job. */
  const review = async (engine: RunReview, input: Partial<RequestReviewInput> = {}, extra: Partial<ReviewJobDeps> = {}) => {
    const requested = await requestReview(
      { db, queue, debounceMs: 0 },
      { orgId: "org_a", repoId: repo.id, prNumber: 7, trigger: "manual", ...input },
    );
    const result = await runReviewJob(deps(engine, extra), { runId: requested.runId, orgId: "org_a", repoId: repo.id, prNumber: 7 });
    return { ...result, runId: requested.runId };
  };

  const run = async (runId: number) => (await db.select().from(reviewRuns).where(eq(reviewRuns.id, runId)))[0]!;

  return { db, fixture, host, repo, pr, base, head, queue, llm, deps, push, review, run };
}
