/**
 * End to end (R6.23): the whole loop on the demo fixture repository (`fixtures/demo-repo`, a payments service whose
 * pull request swaps `applyDiscount`'s parameters while its caller in another file is left alone), driven only through
 * public entry points: the signed GitHub webhook handler, the worker's job runner (`runObservedJob`), the CLI, and
 * the dashboard's data functions. Everything below the model is real: indexer, retrieval, classification, agents,
 * verifier, identity tracking, publishing, conversations, and usage accounting. The model is a fake scripted by task
 * and agent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { completeInstallation } from "@/lib/data/installations";
import { getReviewDetail } from "@/lib/data/reviews";
import { conversations, findings, mentionReplies, reviewRuns, usageEvents, webhookDeliveries } from "@/lib/db/schema";
import { runObservedJob, type JobDeps } from "@/lib/jobs/handlers";
import { MemoryQueue, type JobName } from "@/lib/jobs/types";
import { createGateway, modelCallTotals, PostgresModelCallRecorder } from "@/lib/llm";
import { FakeEmbeddings, FakeLlm, type FakeCall } from "@/lib/llm/fake";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { cliReviewJsonSchema } from "@/packages/cli/src/render";
import { cli, testIo } from "./helpers/cli";
import { createTestDb } from "./helpers/db";
import { demoBugCandidate, demoCheckout, demoScenario } from "./helpers/demo-world";
import { SUMMARY_MARKER } from "@/lib/engine";
import { createGitLabWebhookHandler } from "@/lib/webhooks/gitlab";
import { callerBug, engineLlm, judgedFindings, PRICING } from "./helpers/engine";
import { HEAD_PRICING } from "./helpers/review-fixture";
import { APP_URL, PROJECT_ID, scmFixture } from "./helpers/scm-fixture";
import { addReviewReply, FakeGitHost } from "./helpers/fake-git";
import { tempDir, type FixtureRepo } from "./helpers/fixture-repo";
import { addPrFromFixture } from "./helpers/pr";

const REPO = "acme/payments";
const PR = 12;
const ORG = "org_e2e";
const SECRET = "e2e-webhook-secret";
const CALLER = "const discounted = coupon ? applyDiscount(subtotal, coupon.percentOff) : subtotal;";

const fixtures: FixtureRepo[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

/** Prior finding ids in a resolution prompt. */
const priorIds = (call: FakeCall) => [...call.req.prompt.matchAll(/<prior_finding nonce="[0-9a-f]+" id="(\d+)"/g)].map((m) => m[1]!);

/**
 * The scripted model. While the bug is present the correctness reviewer reports it, but only when the prompt shows
 * it the caller from the other file (so the finding depends on retrieved context, not on the diff alone). The judge
 * accepts what it is shown; the resolution check reports a prior finding fixed once the signature is back to
 * (amountCents, percentOff); conversation answers explain the failure from the finding.
 */
function scriptedModel() {
  const bug = demoBugCandidate();
  const engine = engineLlm({
    review: (agent, call) => ({ findings: agent === "correctness" && call.req.prompt.includes(CALLER) && call.req.prompt.includes("applyDiscount(percentOff: number") ? [bug] : [] }),
    resolve: (call) => ({
      results: priorIds(call).map((id) => ({ id, fixed: call.req.prompt.includes("applyDiscount(amountCents: number, percentOff: number"), reason: "applyDiscount takes (amountCents, percentOff) again, matching buildInvoice." })),
    }),
  });
  return new FakeLlm(async (call) => {
    if (call.req.meta?.agent === "conversation") {
      if (call.req.task === "chat") {
        return "Because `buildInvoice` in `src/billing/invoices.ts:15` still calls `applyDiscount(subtotal, coupon.percentOff)`: a 12,000-cent subtotal becomes the percentage (capped at 30) and the 20% coupon becomes the amount, so the invoice is billed 14 cents.";
      }
      return { intent: "why_bug" };
    }
    if (call.kind === "json") return (await engine.json(call.req)).data;
    return (await engine.text(call.req)).text;
  });
}

async function world() {
  const scenario = await demoScenario();
  const db = await createTestDb();
  const checkout = demoCheckout();
  fixtures.push(checkout.fixture);
  const { fixture } = checkout;
  const host = new FakeGitHost();
  host.treeAt = (_repo, ref) => fixture.git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
  host.contentAt = (_repo, p, ref) => {
    try {
      return fixture.git("show", `${ref}:${p}`) + "\n";
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
        const [code, p] = line.split("\t") as [string, string];
        return { path: p, status: code === "A" ? ("added" as const) : code === "D" ? ("removed" as const) : ("modified" as const) };
      });
  host.addInstallation(11, "acme", [{ id: 1, fullName: REPO, defaultBranch: "main", private: true }]);
  host.cloneUrls.set(REPO, fixture.url);

  const queue = new MemoryQueue();
  const fake = scriptedModel();
  // Through the model gateway, so every call is accounted in model_calls like in production.
  const llm = createGateway({ env: { LLM_PROVIDER: "fake" }, provider: fake, recorder: new PostgresModelCallRecorder(db) });
  const jobDeps: JobDeps = { db, host, queue, llm, embedder: new FakeEmbeddings(), cacheDir: tempDir(), botMention: "openreview" };
  const handler = createGitHubWebhookHandler(() => ({ db, queue, host, secret: SECRET, botMention: "openreview" }));

  const deliver = async (event: string, id: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const res = await handler(
      new Request("https://openreview.example/api/webhooks/github", {
        method: "POST",
        body,
        headers: { "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload(SECRET, body) },
      }),
    );
    return { status: res.status, body: (await res.json()) as { status: string; jobs?: string[] } };
  };

  /** Runs queued jobs of the given kinds through the worker's runner, oldest first; returns their results. */
  const drain = async (...names: JobName[]) => {
    const results: { name: JobName; result: unknown }[] = [];
    for (const job of [...queue.jobs]) {
      if (!names.includes(job.name) || queue.settled.has(job.jobId)) continue;
      const result = await runObservedJob(jobDeps, { name: job.name, id: job.jobId, data: job.data, attemptsMade: 0, maxAttempts: 3 });
      queue.settle(job.jobId, "done");
      results.push({ name: job.name, result });
    }
    return results;
  };

  const prPayload = (action: string, head: string) => ({
    action,
    installation: { id: 11 },
    repository: { id: 1, full_name: REPO },
    sender: { login: scenario.pullRequest.author, type: "User" },
    pull_request: { number: PR, draft: false, head: { sha: head, ref: "discount-cap" }, base: { ref: "main", sha: checkout.base }, user: { login: scenario.pullRequest.author } },
  });

  return { scenario, db, checkout, fixture, host, queue, fake, jobDeps, deliver, drain, prPayload };
}

describe("end to end on the demo repository (R6.23)", () => {
  test("R6.23 webhook → index → retrieval → verified cross-file finding → inline comment and summary → answered follow-up → fixing push resolves it", async () => {
    const w = await world();
    const { db, host, fake, scenario, checkout } = w;

    // Install: the org connects the installation; its first index runs as a worker job with the real indexer.
    const { repos } = await completeInstallation(db, host, { orgId: ORG, orgName: "Acme", installationId: 11 });
    const repo = repos[0]!;
    await w.queue.add("index-repo", { orgId: ORG, repoId: repo.id, mode: "full", trigger: "install" }, { jobId: `index-${repo.id}` });
    const [indexed] = await w.drain("index-repo");
    expect(indexed!.result).toMatchObject({ status: "completed", kind: "full" });

    // The pull request: only pricing.ts and its test change; the caller in invoices.ts is NOT in the diff.
    addPrFromFixture(host, checkout.fixture, REPO, { number: PR, base: checkout.base, head: checkout.head, title: scenario.pullRequest.title, body: scenario.pullRequest.body, author: scenario.pullRequest.author });
    const prFiles = await host.client().listPullRequestFiles(REPO, PR);
    expect(prFiles.map((f) => f.path).sort()).toEqual(["src/billing/pricing.ts", "test/pricing.test.ts"]);

    // 1. A signed pull_request.opened delivery is accepted and recorded, and queues a tracked review run.
    const opened = await w.deliver("pull_request", "delivery-opened", w.prPayload("opened", checkout.head));
    expect(opened).toMatchObject({ status: 202, body: { status: "accepted" } });
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, "delivery-opened"));
    expect(delivery).toMatchObject({ provider: "github", event: "pull_request", action: "opened", orgId: ORG, repoId: repo.id, status: "accepted" });
    expect(delivery!.jobs).toEqual(opened.body.jobs);

    // 2. The worker runs the review job: real retrieval, classification, agents, verifier, publishing.
    const [reviewed] = await w.drain("review-pr");
    expect(reviewed!.result).toMatchObject({ status: "completed", findings: 1, posted: 1 });

    // The reviewer saw the caller's code from ANOTHER file, retrieved from the index (context outside the diff).
    const reviewerCall = fake.calls.find((c) => c.req.task === "review" && c.req.meta?.agent === "correctness")!;
    expect(reviewerCall.req.prompt).toMatch(/<repo_code nonce="[0-9a-f]+" path="src\/billing\/invoices\.ts"/);
    expect(reviewerCall.req.prompt).toContain(CALLER);
    // The judge was shown the cross-file evidence.
    const judge = fake.calls.find((c) => c.req.task === "verify" && c.req.meta?.agent === "verifier")!;
    expect(judgedFindings(judge).map((j) => j.finding.title)).toEqual([demoBugCandidate().title]);
    expect(judge.req.prompt).toMatch(/<evidence nonce="[0-9a-f]+" id="c1" path="src\/billing\/invoices\.ts" lines="15-15">/);

    // 3. The verified finding is persisted with its evidence and verification.
    const [finding] = await db.select().from(findings).where(and(eq(findings.orgId, ORG), eq(findings.visibility, "published")));
    expect(finding).toMatchObject({ path: scenario.bug.path, startLine: scenario.bug.line, severity: "critical", category: "correctness", status: "open", symbol: "applyDiscount" });
    expect((finding!.evidence as { path: string; startLine: number }[]).map((e) => `${e.path}:${e.startLine}`)).toEqual([
      `${scenario.bug.path}:${scenario.bug.line}`,
      `${scenario.bug.caller.path}:${scenario.bug.caller.line}`,
    ]);
    expect(finding!.verification).toMatchObject({ verdict: "accept" });

    // 4. One GitHub review with one inline comment: explanation, evidence, and an exact suggestion block.
    expect(host.reviews).toHaveLength(1);
    expect(host.reviews[0]!.commitId).toBe(checkout.head);
    const [comment] = host.reviews[0]!.comments;
    expect(comment).toMatchObject({ path: scenario.bug.path, line: scenario.bug.line });
    expect(comment!.body).toContain("**Critical · Correctness**");
    expect(comment!.body).toContain("still passes (subtotal, percentOff)");
    expect(comment!.body).toContain(`**Evidence**`);
    expect(comment!.body).toContain(`\`${scenario.bug.caller.path}:${scenario.bug.caller.line}\``);
    expect(comment!.body).toContain("```suggestion\nexport function applyDiscount(amountCents: number, percentOff: number, maxPercentOff = DEFAULT_MAX_PERCENT_OFF): number {\n```");
    expect(comment!.body.endsWith(`<!-- openreview:fp=${finding!.fingerprint} -->`)).toBe(true);
    const root = host.reviewComments.get(`${REPO}#${PR}`)![0]!;
    expect(finding!.externalCommentId).toBe(root.id);

    // 5. The summary comment.
    const summaries = () => host.issueComments.get(`${REPO}#${PR}`)!.filter((c) => c.body.includes("<!-- openreview:summary -->"));
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]!.body).toContain(`| Critical | \`${scenario.bug.path}:${scenario.bug.line}\` |`);

    // 6. A follow-up question in the finding's thread is answered there, grounded in the finding and its evidence.
    addReviewReply(host, REPO, PR, { id: 5001, inReplyTo: root.id, body: "@openreview why is this a bug?", author: "dana" });
    const mention = await w.deliver("pull_request_review_comment", "delivery-mention", {
      action: "created",
      installation: { id: 11 },
      repository: { id: 1, full_name: REPO },
      sender: { login: "dana", type: "User" },
      pull_request: { number: PR },
      comment: { id: 5001, body: "@openreview why is this a bug?", user: { login: "dana", type: "User" }, path: scenario.bug.path, line: scenario.bug.line, in_reply_to_id: root.id, author_association: "MEMBER" },
    });
    expect(mention).toMatchObject({ status: 202, body: { status: "accepted" } });
    const answered = await w.drain("answer-mention");
    expect(answered[0]!.result).toMatchObject({ status: "answered", intent: "why_bug" });
    const chat = fake.calls.find((c) => c.req.meta?.agent === "conversation" && c.req.task === "chat")!;
    expect(chat.req.system).toContain("Task: explain why the finding in the <finding> block is (or is not) a real problem");
    expect(chat.req.prompt).toMatch(new RegExp(`<finding nonce="[0-9a-f]{16}" id="${finding!.id}">`));
    expect(chat.req.prompt).toContain(CALLER);
    const reply = host.reviewComments.get(`${REPO}#${PR}`)!.at(-1)!;
    expect(reply).toMatchObject({ inReplyTo: root.id, author: "openreview[bot]" });
    expect(reply.body).toMatch(/^> why is this a bug\?\n\n@dana Because `buildInvoice` in `src\/billing\/invoices\.ts:15`/);
    expect(await db.select().from(mentionReplies)).toHaveLength(1);
    expect((await db.select().from(conversations)).map((c) => c.findingId)).toEqual([finding!.id]);
    // Feedback collection for the reply to our comment was queued as well; it runs without errors.
    expect((await w.drain("sync-feedback")).length).toBe(1);

    // 7. The author pushes a fix (the original argument order is restored).
    const fixed = checkout.applyFix();
    addPrFromFixture(host, checkout.fixture, REPO, { number: PR, base: checkout.base, head: fixed, title: scenario.pullRequest.title, body: scenario.pullRequest.body, author: scenario.pullRequest.author });
    fake.calls.length = 0;
    expect(await w.deliver("pull_request", "delivery-sync", w.prPayload("synchronize", fixed))).toMatchObject({ status: 202, body: { status: "accepted" } });
    const [rereviewed] = await w.drain("review-pr");
    expect(rereviewed!.result).toMatchObject({ status: "completed", posted: 0, resolved: 1, findings: 0 });

    // An incremental re-review of the new commit only, whose resolution check was asked about the open finding.
    const runs = await db.select().from(reviewRuns).where(eq(reviewRuns.orgId, ORG)).orderBy(reviewRuns.id);
    expect(runs.map((r) => [r.trigger, r.status])).toEqual([
      ["opened", "completed"],
      ["synchronize", "completed"],
    ]);
    expect(runs[1]).toMatchObject({ sinceSha: checkout.head, headSha: fixed, findingsResolved: 1 });
    const resolver = fake.calls.filter((c) => c.req.meta?.agent === "resolver");
    expect(resolver.map(priorIds)).toEqual([[String(finding!.id)]]);

    // 8. The finding is resolved and its comment edited in place; nothing was posted twice.
    const [after] = await db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(after).toMatchObject({ status: "resolved", resolution: "fixed", resolvedSha: fixed });
    expect(host.reviews).toHaveLength(1);
    expect(host.commentEdits).toEqual([{ id: root.id, body: `✅ Resolved in ${fixed.slice(0, 7)}\n\n${comment!.body}` }]);
    const all = host.reviewComments.get(`${REPO}#${PR}`)!;
    expect(all.filter((c) => c.body.includes("openreview:fp="))).toHaveLength(1);
    expect(all.map((c) => c.author)).toEqual(["openreview[bot]", "dana", "openreview[bot]"]);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]!.body).toContain("1 earlier finding resolved");

    // 9. Usage: review and chat usage events, and every model call accounted per run.
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.orgId, ORG));
    expect(usage.filter((u) => u.kind === "review").map((u) => u.reviewRunId)).toEqual(runs.map((r) => r.id));
    expect(usage.filter((u) => u.kind === "chat")).toEqual([expect.objectContaining({ prNumber: PR, author: "dana" })]);
    expect(usage.every((u) => u.inputTokens > 0)).toBe(true);
    for (const r of runs) expect((await modelCallTotals(db, ORG, { reviewRunId: r.id })).calls).toBeGreaterThan(0);

    // 10. The dashboard shows the lifecycle: two runs, the resolved finding, the posted comment.
    const detail = await getReviewDetail(db, ORG, runs[0]!.reviewId!);
    expect(detail).toMatchObject({ provider: "github", repoFullName: REPO, prNumber: PR, status: "completed", openFindings: 0, resolvedFindings: 1, commentCount: 1 });
    expect(detail!.runHistory.map((r) => r.trigger)).toEqual(["synchronize", "opened"]);
    expect(detail!.findings.items).toEqual([expect.objectContaining({ id: finding!.id, status: "resolved", resolvedSha: fixed })]);
    expect(detail!.comments).toEqual([expect.objectContaining({ path: scenario.bug.path, line: scenario.bug.line, externalId: root.id })]);
  });

  test("R6.23 CLI: `openreview review --local --agent` on the fixture branch reports the cross-file finding", async () => {
    const checkout = demoCheckout();
    fixtures.push(checkout.fixture);
    checkout.fixture.git("remote", "add", "origin", "git@github.com:acme/payments.git");
    const model = scriptedModel();
    const io = testIo({ cwd: checkout.fixture.dir, local: { llm: model, embedder: new FakeEmbeddings() } });
    const res = await cli(io, "review", "--local", "--agent", "--fail-on", "high");
    expect(res.err).toBe("");
    // A critical finding fails the --fail-on high gate.
    expect(res.code).toBe(1);
    expect(res.out).toContain("# OpenReview: 1 finding (1 critical) in acme/payments");
    expect(res.out).toContain("## 1. src/billing/pricing.ts:16\nseverity: critical · category: correctness");
    expect(res.out).toContain("still passes (subtotal, percentOff)");
    expect(res.out).toContain("## Fix all\n- [ ] src/billing/pricing.ts:16 — [critical]");
    // The local index gave the reviewer the caller outside the diff.
    expect(model.calls.find((c) => c.req.task === "review" && c.req.meta?.agent === "correctness")!.req.prompt).toContain(CALLER);

    const json = await cli(testIo({ cwd: checkout.fixture.dir, local: { llm: scriptedModel(), embedder: new FakeEmbeddings() } }), "review", "--local", "--json");
    const out = cliReviewJsonSchema.parse(JSON.parse(json.out));
    expect(out.findings.map((f) => [f.path, f.startLine, f.severity])).toEqual([["src/billing/pricing.ts", 16, "critical"]]);
    expect(out.headSha).toBe(checkout.head);
    expect(out.baseSha).toBe(checkout.base);
  });
});

describe("end to end on GitLab (R6.23)", () => {
  beforeAll(() => {
    vi.stubEnv("APP_SECRET", "e2e-gitlab-secret-0123456789");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const HANDLER_CALLER = "return { total: computeTotal(req.items) };";
  const FIXED = HEAD_PRICING.replace("export function computeTotal(items: number[], region: string) {", 'export function computeTotal(items: number[], region = "default") {');

  test("R6.23 GitLab: merge request hook → review with cross-file context → positioned discussion → answered note → fixing push resolves it", async () => {
    const s = await scmFixture("gitlab");
    fixtures.push(s.fx.fixture);
    const { fx, gitlab, host } = s;
    // The scripted reviewer reports the bug until the author pushes the fix.
    const state = { buggy: true };
    const engine = engineLlm({
      review: (agent, call) => ({ findings: agent === "correctness" && state.buggy && call.req.prompt.includes(HANDLER_CALLER) ? [callerBug({ suggestion: 'export function computeTotal(items: number[], region = "default") {' })] : [] }),
      resolve: (call) => ({ results: priorIds(call).map((id) => ({ id, fixed: call.req.prompt.includes('region = "default"'), reason: "region has a default again" })) }),
    });
    const model = new FakeLlm(async (call) => {
      if (call.req.meta?.agent === "conversation") return call.req.task === "chat" ? "handleCheckout in services/api/handlers.ts:4 still calls computeTotal(req.items)." : { intent: "why_bug" };
      return call.kind === "json" ? (await engine.json(call.req)).data : (await engine.text(call.req)).text;
    });
    const queue = new MemoryQueue();
    const deps: JobDeps = { db: fx.db, host, queue, llm: model, embedder: fx.embedder, cacheDir: tempDir(), botMention: "openreview" };
    const handler = createGitLabWebhookHandler(() => ({ db: fx.db, queue, host, botMention: "openreview" }));
    let n = 0;
    const send = async (event: string, payload: object) =>
      (await handler(
        new Request(`${APP_URL}/api/webhooks/gitlab`, {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "x-gitlab-token": gitlab.hooks[0]!.token, "x-gitlab-event": event, "x-gitlab-event-uuid": `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` },
        }),
      ).then((r) => r.json())) as { status: string };
    const drain = async (name: JobName) => {
      const out: unknown[] = [];
      for (const job of queue.jobs.filter((j) => j.name === name && !queue.settled.has(j.jobId))) {
        out.push(await runObservedJob(deps, { name: job.name, id: job.jobId, data: job.data, attemptsMade: 0, maxAttempts: 3 }));
        queue.settle(job.jobId, "done");
      }
      return out;
    };
    const mr = (action: string, extra: Record<string, unknown> = {}) => ({ object_kind: "merge_request", user: { id: 5, username: "dev" }, project: { id: PROJECT_ID }, object_attributes: { iid: 7, action, ...extra } });
    const discussionPosts = () => gitlab.requests.filter((r) => r.method === "POST" && /\/merge_requests\/7\/discussions$/.test(new URL(r.url).pathname));

    // Opened → review job: the reviewer saw the caller in services/api/handlers.ts, which the merge request does not touch.
    expect(await send("Merge Request Hook", mr("open"))).toMatchObject({ status: "accepted" });
    expect(await drain("review-pr")).toEqual([expect.objectContaining({ status: "completed", posted: 1 })]);
    const reviewer = model.calls.find((c) => c.req.task === "review" && c.req.meta?.agent === "correctness")!;
    expect(reviewer.req.prompt).toMatch(/<repo_code nonce="[0-9a-f]+" path="services\/api\/handlers\.ts"/);
    expect(discussionPosts()).toHaveLength(1);
    expect((discussionPosts()[0]!.body as { body: string }).body).toContain('```suggestion:-0+0\nexport function computeTotal(items: number[], region = "default") {\n```');
    const root = gitlab.notes.find((x) => x.type === "DiffNote")!;
    const [finding] = await fx.db.select().from(findings).where(eq(findings.visibility, "published"));
    expect(finding!.externalCommentId).toBe(root.id);

    // A teammate asks in the finding's discussion; the answer lands in the same discussion, grounded in the finding.
    gitlab.members.set(77, 30);
    const question = gitlab.addNote({ body: "@openreview why is this a bug?", username: "li", userId: 77, type: "DiffNote", position: root.position, discussionId: root.discussionId });
    expect(
      await send("Note Hook", {
        object_kind: "note",
        user: { id: 77, username: "li" },
        project: { id: PROJECT_ID },
        merge_request: { iid: 7 },
        object_attributes: { id: question.id, note: question.body, noteable_type: "MergeRequest", discussion_id: root.discussionId, type: "DiffNote", position: { new_path: PRICING, new_line: 3 } },
      }),
    ).toMatchObject({ status: "accepted" });
    expect(await drain("answer-mention")).toEqual([expect.objectContaining({ status: "answered", intent: "why_bug" })]);
    expect(model.calls.find((c) => c.req.task === "chat")!.req.prompt).toMatch(new RegExp(`<finding nonce="[0-9a-f]{16}" id="${finding!.id}">`));
    expect(gitlab.notes.at(-1)).toMatchObject({ discussionId: root.discussionId, author: { username: "project_42_bot" } });

    // The author pushes a fix: GitLab reports an update with new commits.
    state.buggy = false;
    const fixed = fx.fixture.commit({ [PRICING]: FIXED }, "default region");
    const next = addPrFromFixture(fx.host, fx.fixture, "acme/shop", { number: 7, base: fx.base, head: fixed });
    gitlab.world!.pr.head = next.headSha;
    gitlab.world!.files = fx.host.prs.get("acme/shop#7")!.files.map((f) => ({ path: f.path, status: f.status as "modified", patch: f.patch ?? "" }));
    gitlab.world!.commits.push({ sha: fixed, message: "default region", author: "dev", date: "2026-10-02T09:00:00Z" });
    expect(await send("Merge Request Hook", mr("update", { oldrev: fx.head }))).toMatchObject({ status: "accepted" });
    expect(await drain("review-pr")).toEqual([expect.objectContaining({ status: "completed", posted: 0, resolved: 1 })]);

    const [after] = await fx.db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(after).toMatchObject({ status: "resolved", resolvedSha: fixed });
    expect(gitlab.notes.find((x) => x.id === root.id)!.body.startsWith(`✅ Resolved in ${fixed.slice(0, 7)}`)).toBe(true);
    // No duplicate discussion, and one summary note edited in place.
    expect(discussionPosts()).toHaveLength(1);
    expect(gitlab.notes.filter((x) => x.body.startsWith(SUMMARY_MARKER))).toHaveLength(1);
  });
});
