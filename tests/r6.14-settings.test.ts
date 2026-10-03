import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { parseRepoConfig, resolveConfig } from "@/lib/config/repo-config";
import { resolveEffectiveSettings, reviewGate, SETTING_DEFAULTS } from "@/lib/config/settings";
import { updateRepoSettings } from "@/lib/data/installations";
import { getOrgSettings, getRepoEffectiveSettings, updateOrgSettings } from "@/lib/data/settings";
import { reviews } from "@/lib/db/schema";
import { MemoryQueue } from "@/lib/jobs/types";
import { runReviewJob } from "@/lib/review/run";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { pipelineFixture } from "./helpers/pipeline";
import { reviewOutput, stubEngine } from "./helpers/stub-engine";

type Fixture = Awaited<ReturnType<typeof pipelineFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const okEngine = () => stubEngine(() => reviewOutput());

describe("review settings", () => {
  test("R6.14 has sensible defaults and resolves org < repo < file key by key, with sources", () => {
    expect(SETTING_DEFAULTS).toMatchObject({
      autoReview: true,
      reviewDrafts: false,
      targetBranches: [],
      ignoredBranches: [],
      maxComments: 20,
      minConfidence: 0.4,
      minSeverity: "low",
      mode: "standard",
      autoReReview: true,
      commentStyle: "concise",
      model: null,
      customInstructions: null,
    });
    const { settings, sources } = resolveEffectiveSettings(
      { mode: "deep", maxComments: 5, autoReview: false, commentTypes: ["security"] },
      { maxComments: 8, strictness: "low", categories: ["correctness", "testing"] },
      { maxComments: 12, commentStyle: "detailed" },
    );
    expect(settings).toMatchObject({ mode: "deep", maxComments: 12, autoReview: false, commentStyle: "detailed", categories: ["correctness", "testing"] });
    expect(sources).toMatchObject({ mode: "org", maxComments: "file", autoReview: "org", commentStyle: "file", categories: "repo", reviewDrafts: "default" });
    // Strictness is a preset: thresholds without an explicit value follow it.
    expect(settings).toMatchObject({ strictness: "low", minConfidence: 0.8, minSeverity: "medium" });
    expect(sources).toMatchObject({ strictness: "repo", minConfidence: "strictness", minSeverity: "strictness" });
    // Legacy comment types map onto the agents that cover them.
    expect(resolveEffectiveSettings(undefined, { commentTypes: ["logic", "style"] }, undefined).settings.categories).toEqual(["correctness", "rules"]);
    // openreview.json accepts every setting; unknown keys and bad values are reported.
    expect(parseRepoConfig(JSON.stringify({ autoReview: false, targetBranches: ["main"], minConfidence: 0.7, mode: "fast" })).config).toBeDefined();
    expect(parseRepoConfig(JSON.stringify({ minConfidence: 7 })).error).toMatch(/^openreview.json: minConfidence:/);
    expect(parseRepoConfig(JSON.stringify({ mode: "turbo" })).error).toMatch(/^openreview.json: mode:/);
    expect(resolveConfig({ ignore: ["dist/**"] }, { ignore: ["gen/**"] }, [], { ignore: ["x/**"], mode: "fast" })).toMatchObject({
      ignore: ["gen/**"],
      settings: { mode: "fast" },
      settingSources: { ignore: "file", mode: "org" },
    });
  });

  test("R6.14 the review gates only apply to automatic triggers", () => {
    const s = { ...SETTING_DEFAULTS };
    const pr = { trigger: "opened", draft: false, baseRef: "main", headRef: "feature/x" };
    expect(reviewGate(s, pr)).toBeNull();
    expect(reviewGate({ ...s, autoReview: false }, pr)).toBe("automatic review is turned off");
    expect(reviewGate({ ...s, autoReview: false }, { ...pr, trigger: "manual" })).toBeNull();
    expect(reviewGate({ ...s, autoReReview: false }, { ...pr, trigger: "synchronize" })).toBe("automatic re-review on new commits is turned off");
    expect(reviewGate({ ...s, autoReReview: false }, pr)).toBeNull();
    expect(reviewGate(s, { ...pr, draft: true })).toBe("draft pull requests are not reviewed");
    expect(reviewGate({ ...s, reviewDrafts: true }, { ...pr, draft: true })).toBeNull();
    expect(reviewGate({ ...s, targetBranches: ["release/*"] }, pr)).toBe("base branch main is not a target branch");
    expect(reviewGate({ ...s, targetBranches: ["release/*", "main"] }, pr)).toBeNull();
    expect(reviewGate({ ...s, ignoredBranches: ["feature/**"] }, pr)).toBe("branch feature/x is ignored");
    expect(reviewGate({ ...s, ignoredBranches: ["feature/**"] }, { ...pr, trigger: "cli" })).toBeNull();
  });

  test("R6.14 automatic review off skips webhook-triggered runs with a reason, but a manual re-review runs", async () => {
    fx = await pipelineFixture();
    await updateOrgSettings(fx.db, "org_a", { autoReview: false });
    const engine = okEngine();
    const auto = await fx.review(engine.run, { trigger: "opened", headSha: fx.head });
    expect(auto).toMatchObject({ status: "skipped", reason: "automatic review is turned off" });
    expect(await fx.run(auto.runId)).toMatchObject({ status: "skipped", statusReason: "automatic review is turned off" });
    expect(engine.calls).toHaveLength(0);
    expect(fx.host.issueComments.size).toBe(0);
    expect(await fx.review(engine.run, { trigger: "manual" })).toMatchObject({ status: "completed" });
  });

  test("R6.14 drafts are skipped unless reviewDrafts is on, at the webhook and in the job", async () => {
    fx = await pipelineFixture();
    fx.pr.draft = true;
    const engine = okEngine();
    expect(await fx.review(engine.run, { trigger: "opened", headSha: fx.head })).toMatchObject({ status: "skipped", reason: "draft pull requests are not reviewed" });

    const queue = new MemoryQueue();
    const handler = createGitHubWebhookHandler(() => ({ db: fx!.db, queue, host: fx!.host, secret: "s", botMention: "openreview" }));
    const send = (id: string, extra: Record<string, unknown> = {}) => {
      const body = JSON.stringify({
        action: "opened",
        installation: { id: 11 },
        repository: { id: 1 },
        pull_request: { number: 7, draft: true, head: { sha: fx!.head, ref: "feature" }, ...extra },
      });
      return handler(new Request("http://x", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload("s", body) } }));
    };
    expect(await (await send("d-1")).json()).toEqual({ status: "ignored", reason: "draft pull requests are not reviewed" });
    expect(queue.jobs).toHaveLength(0);

    // openreview.json at the base commit wins over the dashboard (R2.2), at the webhook as in the job.
    const contentAt = fx.host.contentAt!;
    fx.host.contentAt = (repo, path, ref) => (path === "openreview.json" && ref === fx!.base ? JSON.stringify({ reviewDrafts: true }) : contentAt(repo, path, ref));
    expect(await (await send("d-2", { base: { ref: "main", sha: fx.base } })).json()).toMatchObject({ status: "accepted" });
    expect(await fx.review(engine.run, { trigger: "opened", headSha: fx.head })).toMatchObject({ status: "completed" });
    fx.host.contentAt = contentAt;

    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { reviewDrafts: true });
    expect(await (await send("d-3")).json()).toMatchObject({ status: "accepted" });
    expect(await fx.review(engine.run, { trigger: "opened", headSha: fx.head })).toMatchObject({ status: "completed" });
  });

  test("R6.14 reviewDrafts in openreview.json takes effect at the webhook, and an unreadable file defers the draft decision to the job", async () => {
    fx = await pipelineFixture();
    fx.pr.draft = true;
    const engine = okEngine();
    const queue = new MemoryQueue();
    const handler = createGitHubWebhookHandler(() => ({ db: fx!.db, queue, host: fx!.host, secret: "s", botMention: "openreview" }));
    // Payloads without the base commit: the gate learns it from the PR and reads openreview.json there.
    const send = (id: string) => {
      const body = JSON.stringify({ action: "opened", installation: { id: 11 }, repository: { id: 1 }, pull_request: { number: 7, draft: true, head: { sha: fx!.head, ref: "feature" } } });
      return handler(new Request("http://x", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload("s", body) } }));
    };
    const contentAt = fx.host.contentAt!;
    fx.host.contentAt = (repo, path, ref) => (path === "openreview.json" && ref === fx!.base ? JSON.stringify({ reviewDrafts: true }) : contentAt(repo, path, ref));
    expect(await (await send("e-1")).json()).toMatchObject({ status: "accepted" });
    const first = queue.jobs.at(-1)!.data as { runId: number };
    const done = await runReviewJob(fx.deps(engine.run), { runId: first.runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(done).toMatchObject({ status: "completed" });

    // The file cannot be read at the webhook (a git host error): the draft is not dropped there; the job reads the
    // file (which no longer enables drafts) and skips the run with the gate's reason.
    let failures = 1;
    fx.host.contentAt = (repo, path, ref) => {
      if (path === "openreview.json" && failures-- > 0) throw new Error("502 Bad Gateway");
      return contentAt(repo, path, ref);
    };
    const head2 = fx.push({ "services/billing/extra.ts": "export const x = 1;\n" }, { draft: true });
    const body = JSON.stringify({ action: "opened", installation: { id: 11 }, repository: { id: 1 }, pull_request: { number: 7, draft: true, head: { sha: head2, ref: "feature" }, base: { ref: "main", sha: fx.base } } });
    const res = await handler(new Request("http://x", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": "e-2", "x-hub-signature-256": signGitHubPayload("s", body) } }));
    expect(await res.json()).toMatchObject({ status: "accepted" });
    const second = queue.jobs.at(-1)!.data as { runId: number };
    expect(await runReviewJob(fx.deps(engine.run), { runId: second.runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 })).toMatchObject({
      status: "skipped",
      reason: "draft pull requests are not reviewed",
    });
  });

  test("R6.14 a gated push never supersedes the review in progress, and a skipped run keeps the completed review", async () => {
    fx = await pipelineFixture();
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { autoReReview: false });
    const queue = new MemoryQueue();
    const handler = createGitHubWebhookHandler(() => ({ db: fx!.db, queue, host: fx!.host, secret: "s", botMention: "openreview" }));
    const send = (id: string, action: string, sha: string) => {
      const body = JSON.stringify({
        action,
        installation: { id: 11 },
        repository: { id: 1 },
        pull_request: { number: 7, draft: false, head: { sha, ref: "feature" }, base: { ref: "main", sha: fx!.base } },
      });
      return handler(new Request("http://x", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload("s", body) } }));
    };
    expect(await (await send("d-1", "opened", fx.head)).json()).toMatchObject({ status: "accepted" });
    const first = queue.jobs[0]!.data as { runId: number };

    // A push lands while the first review is running: re-review is off, so no run is recorded and nothing is cancelled.
    let pushed = "";
    const engine = stubEngine(async () => {
      pushed = fx!.push({ "services/billing/extra.ts": "export const x = 1;\n" });
      expect(await (await send("d-2", "synchronize", pushed)).json()).toEqual({ status: "ignored", reason: "automatic re-review on new commits is turned off" });
      return reviewOutput();
    });
    const res = await runReviewJob(fx.deps(engine.run), { runId: first.runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(res).toMatchObject({ status: "completed" });
    expect(queue.jobs).toHaveLength(1);
    expect(await fx.run(first.runId)).toMatchObject({ status: "completed", cancelRequested: false });

    // A run the job's own gate skips (openreview.json turns automatic review off) leaves the completed review as it was.
    const contentAt = fx.host.contentAt!;
    fx.host.contentAt = (repo, path, ref) => (path === "openreview.json" ? JSON.stringify({ autoReview: false }) : contentAt(repo, path, ref));
    expect(await fx.review(okEngine().run, { trigger: "opened", headSha: pushed })).toMatchObject({ status: "skipped", reason: "automatic review is turned off" });
    const [review] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(review).toMatchObject({ status: "completed", runs: 1 });
  });

  test("R6.14 target and ignored branches (globs) and automatic re-review gate runs", async () => {
    fx = await pipelineFixture();
    const engine = okEngine();
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { targetBranches: ["release/*"] });
    expect(await fx.review(engine.run, { trigger: "opened", headSha: fx.head })).toMatchObject({ reason: "base branch main is not a target branch" });
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { ignoredBranches: ["feat*"] });
    expect(await fx.review(engine.run, { trigger: "reopened", headSha: fx.head })).toMatchObject({ reason: "branch feature is ignored" });
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { autoReReview: false });
    expect(await fx.review(engine.run, { trigger: "synchronize", headSha: fx.head })).toMatchObject({
      status: "skipped",
      reason: "automatic re-review on new commits is turned off",
    });
    expect(await fx.review(engine.run, { trigger: "opened", headSha: fx.head })).toMatchObject({ status: "completed" });
    expect(engine.calls).toHaveLength(1);
  });

  test("R6.14 thresholds, categories, ignored paths, model, mode, instructions and comment style reach the engine", async () => {
    fx = await pipelineFixture({
      baseExtra: { "openreview.json": JSON.stringify({ minConfidence: 0.7, categories: ["security", "rules"], commentStyle: "detailed" }) },
    });
    await updateOrgSettings(fx.db, "org_a", { mode: "deep", maxComments: 3, customInstructions: "Flag every TODO." });
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { minConfidence: 0.5, minSeverity: "high", ignore: ["gen/**"], model: "claude-review-x" });
    const engine = okEngine();
    expect(await fx.review(engine.run)).toMatchObject({ status: "completed" });
    const req = engine.calls[0]!;
    expect(req.mode).toBe("deep");
    expect(req.settings).toEqual({
      minConfidence: 0.7,
      minSeverity: "high",
      maxComments: 3,
      categories: ["security", "rules"],
      ignoredPaths: ["gen/**"],
      customInstructions: "Flag every TODO.",
      commentStyle: "detailed",
      model: "claude-review-x",
    });
    expect(await fx.run((await fx.review(engine.run, { mode: "fast" })).runId)).toMatchObject({ mode: "fast" });
    expect(engine.calls[1]!.mode).toBe("fast");

    expect(await getOrgSettings(fx.db, "org_a")).toMatchObject({ mode: "deep" });
    expect(await getRepoEffectiveSettings(fx.db, "org_a", fx.repo.id)).toMatchObject({
      settings: { mode: "deep", minConfidence: 0.5, model: "claude-review-x" },
      sources: { mode: "org", minConfidence: "repo", autoReview: "default" },
    });
    expect(await getRepoEffectiveSettings(fx.db, "org_b", fx.repo.id)).toBeUndefined();
    await expect(updateRepoSettings(fx.db, "org_a", fx.repo.id, { minConfidence: 2 })).rejects.toThrow();
    await expect(updateOrgSettings(fx.db, "org_a", { reviewDraft: true } as never)).rejects.toThrow();
  });
});
