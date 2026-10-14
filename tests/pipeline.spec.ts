import { expect, test, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { z } from "zod";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";
import { HttpModel,ModelFailure } from "../src/engine/model";
import type { ModelRequest } from "../src/engine/types";

const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("webhook through indexing, cross-file review, persistence, publish, feedback and fixed-commit resolution", async () => {
  process.env.SERVICE_SECRET = "pipeline-service";
  process.env.SESSION_SECRET = "pipeline-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const publish = vi
    .spyOn(Github.prototype, "publish")
    .mockResolvedValue({ id: 500, reused: false });
  const reply = vi
    .spyOn(Github.prototype, "reply")
    .mockRejectedValueOnce(new Error("Transient publish failure"))
    .mockResolvedValue({ id: 501 });
  vi.spyOn(Github, "installation").mockResolvedValue(
    new Github("test-only-token"),
  );
  vi.spyOn(Github.prototype, "request").mockImplementation(
    async (_path, validator) => validator.parse(_path.endsWith("/permission")?{permission:"write"}:_path.endsWith("/pulls/1")?{
      number:1,title:"Change authentication guard",draft:false,state:"open",html_url:"https://github.com/test/fixture/pull/1",user:{login:"author"},head:{sha:fixed?"c".repeat(40):"b".repeat(40),ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},
    }:{ sha: "a".repeat(40) }),
  );
  vi.spyOn(Github.prototype,"openChanges").mockResolvedValue({numbers:[],next:null});
  vi.spyOn(Github.prototype, "branches").mockResolvedValue({
    branches: [{ name: "main", sha: "a".repeat(40), protected: true }],
    limited: false,
  });
  const oldFile =
    "export function allowed(user) {\n  return !!user && user.active === true;\n}";
  const changedFile =
    "export function allowed(user) {\n  return user?.active !== false;\n}";
  const caller =
    "import { allowed } from './auth';\nexport function route(user) { if (allowed(user)) return secret; }";
  let fixed = false;
  let failSummaryOnce = true,failConversation=false;
  vi.spyOn(Github.prototype, "tree").mockImplementation(async (_repo, sha) => [
    {
      path: "auth.ts",
      sha: sha === "b".repeat(40) ? "b" : "a",
      type: "blob",
      size: 100,
    },
    { path: "route.ts", sha: "c", type: "blob", size: 100 },
  ]);
  vi.spyOn(Github.prototype, "blob").mockImplementation(
    async (_repo, path, sha) => ({
      path,
      sha,
      content:
        path === "route.ts"
          ? caller
          : sha === "b" && !fixed
            ? changedFile
            : oldFile,
    }),
  );
  const patch =
    "@@ -1,3 +1,3 @@\n export function allowed(user) {\n-  return !!user && user.active === true;\n+  return user?.active !== false;\n }";
  vi.spyOn(Github.prototype, "pullRequest").mockImplementation(async () => ({
    number: 1,
    title: "Change authentication guard",
    body: "",
    draft: false,
    state: "open",
    html_url: "https://github.com/test/fixture/pull/1",
    user: { login: "author" },
    head: { sha: fixed ? "c".repeat(40) : "b".repeat(40), ref: "feature" },
    base: { sha: "a".repeat(40), ref: "main" },
    diff: [{ path: "auth.ts", patch, status: "modified" }],
    comments: [],
    reviews: [],
    commits: [],
    checks: [],
  }));
  let lastFingerprint = "";
  vi.spyOn(HttpModel.prototype, "generate").mockImplementation(
    async function generate<T>(request: ModelRequest, validator: z.ZodType<T>) {
      if(request.task==="conversation"&&failConversation){failConversation=false;throw new ModelFailure("Invalid source citation",{task:"conversation",provider:"test-fixture",model:"fixture",inputTokens:100,outputTokens:50,latencyMs:1,estimatedCost:0.01,cached:false});}
      if (request.task === "summary" && !fixed && failSummaryOnce) {
        failSummaryOnce = false;
        throw new Error("Transient summary failure");
      }
      const candidate = {
        title: "Missing user bypasses authorization",
        description:
          "The guard authorizes undefined users and the route returns private data.",
        severity: "high",
        confidence: 0.99,
        category: "security",
        filePath: "auth.ts",
        startLine: 2,
        endLine: 2,
        evidence: [
          {
            filePath: "auth.ts",
            startLine: 2,
            quote: "  return user?.active !== false;",
          },
          { filePath: "route.ts", startLine: 2, quote: caller.split("\n")[1] },
        ],
        impact: "Unauthenticated clients receive private data.",
        suggestedFix: "Require a non-null user and active === true.",
        symbol: "allowed",
      };
      let value: unknown = {
        reviewScore:{value:fixed?4:1,reason:fixed?"Current source restores the guard; broader deployment readiness remains unverified.":"The verified authorization defect must be corrected before merging."},summary:
          "The PR changes the authentication guard. A cross-file authorization defect is verified.",
      };
      if (request.task.startsWith("review:")) {
        if (fixed)
          expect(
            (request.context as { historicalFindings: { title: string }[] })
              .historicalFindings,
          ).toHaveLength(1);
        const context = (request.context as { context: { path: string }[] })
          .context;
        expect(context.some((c) => c.path === "route.ts")).toBe(true);
        value = {
          findings:
            !fixed && request.task === "review:security" ? [candidate] : [],
        };
      } else if (request.task === "verify")
        value = {
          decisions: [
            {
              index: 0,
              publish: true,
              confidence: 0.99,
              reason: "Undefined passes guard and caller returns private data.",
            },
          ],
        };
      else if (request.task === "resolution")
        value = {
          resolved: [
            {
              fingerprint: lastFingerprint,
              evidence:
                "Guard now explicitly requires a user with active === true.",
              filePath:"auth.ts",startLine:2,quote:"  return !!user && user.active === true;",
            },
          ],
        };
      else if (request.task === "knowledge")
        value = {
          entries: [
            {
              subsystem: "Authorization",
              description:
                "The route checks an authorization helper before reading private data.",
              files: ["auth.ts", "route.ts"],
              dependencies: [],
              risks: ["Missing user authorization"],
              conventions: [],
            },
          ],
        };
      else if (request.task === "conversation")
        value = {
          answer:
            "The missing user passes the authorization guard. Require a non-null active user before returning private data.",
          citations:[{filePath:(request.input as {sources:{path:string;lines:{line:number;text:string}[]}[]}).sources[0].path,startLine:1,quote:(request.input as {sources:{path:string;lines:{line:number;text:string}[]}[]}).sources[0].lines[0].text}],
        };
      return {
        value: validator.parse(value),
        usage: {
          task: request.task,
          provider: "test-fixture",
          model: "deterministic-orchestration",
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
          estimatedCost: 0,
          cached: false,
        },
      };
    },
  );
  const userId = await t.mutation(api.users.login, {
    secret: "pipeline-service",
    githubId: -200,
    login: "pipeline-fixture",
    avatar: "",
  });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("openreview")
    .setAudience("openreview")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, {
    token,
    name: "Pipeline test",
  });
  await t.mutation(api.repositories.connect, {
    token,
    secret: "pipeline-service",
    organizationId,
    installationId: -200,
    accountId: -200,
    account: "test",
    repositories: [
      { id: -200, fullName: "test/fixture", defaultBranch: "main" },
    ],
  });
  const [repo] = await t.query(api.repositories.list, {
    token,
    organizationId,
  });
  vi.useFakeTimers();
  await t.mutation(api.repositories.configure, {
    token,
    repositoryId: repo._id,
    enabled: true,
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect(
    (await t.query(api.repositories.list, { token, organizationId }))[0]
      .indexStatus,
  ).toBe("ready");
  expect(
    (await t.query(api.repositories.list, { token, organizationId }))[0]
      .branches,
  ).toHaveLength(1);
  expect(
    await t.query(api.dashboard.knowledge, { token, repositoryId: repo._id }),
  ).toHaveLength(1);
  const payload = {
    action: "opened",
    installation: { id: -200 },
    repository: { id: -200 },
    pull_request: {
      number: 1,
      draft: false,
      state: "open",
      head: { sha: "b".repeat(40), ref: "feature" },
      base: { ref: "main" },
    },
  };
  const payloadStorageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(payload)])),
  );
  await t.mutation(internal.webhooks.receive, {
    deliveryId: "pipeline-delivery",
    event: "pull_request",
    payloadStorageId,
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const dashboard = await t.query(api.dashboard.overview, {
    token,
    organizationId,
  });
  expect(dashboard.reviews[0].status).toBe("completed");
  expect(dashboard.reviews[0].reviewScore).toEqual({value:1,reason:"The verified authorization defect must be corrected before merging."});
  expect(publish.mock.calls[0][3]).toContain("### Confidence score\n**1/5**");
  expect(
    (
      await t.query(api.reviews.detail, {
        token,
        reviewId: dashboard.reviews[0]._id,
      })
    ).modelCalls.some((call) => call.error === "Transient summary failure"),
  ).toBe(true);
  expect(dashboard.findings).toHaveLength(1);
  expect(
    (
      await t.query(api.dashboard.knowledge, { token, repositoryId: repo._id })
    )[0].pastFindings,
  ).toHaveLength(1);
  expect(publish).toHaveBeenCalledOnce();
  expect(publish.mock.calls[0][4]).toHaveLength(1);
  expect(dashboard.usage.length).toBeGreaterThan(1);
  await expect(
    t.action(internal.conversationJobs.reply, {
      repositoryId: repo._id,
      prNumber: 1,
      commentId: 701,
      author: "author",
      question: "@openreview explain this",
      inline: false,
    }),
  ).rejects.toThrow("Transient publish failure");
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect(reply).toHaveBeenCalledTimes(2);
  const conversations = await t.query(internal.conversations.context, {
    repositoryId: repo._id,
    prNumber: 1,
  });
  expect(conversations.conversations[0]).toMatchObject({
    status: "completed",
    attempts: 2,
  });
  expect(
    (
      await t.query(api.dashboard.overview, { token, organizationId })
    ).usage.filter((event) => event.kind === "conversation"),
  ).toHaveLength(1);
  lastFingerprint = dashboard.findings[0].fingerprint;
  publish.mockRejectedValueOnce(new Error("Retry carried-finding publication"));
  const repeated=await t.mutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:1,headSha:"b".repeat(40),force:true});
  expect(repeated).toBeTruthy();
  await t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
  expect((await t.query(api.reviews.detail,{token,reviewId:repeated!})).review.status).toBe("completed");
  expect(publish.mock.calls[1][4]).toHaveLength(0);
  expect(publish.mock.calls[1][8]).toBe(1);
  expect(publish.mock.calls[2][4]).toHaveLength(0);
  expect(publish.mock.calls[2][8]).toBe(1);
  await t.mutation(api.dashboard.feedback, {
    token,
    findingId: dashboard.findings[0]._id,
    value: "useful",
    comment: "Verified on missing user",
  });
  await t.mutation(api.dashboard.feedback, {
    token,
    findingId: dashboard.findings[0]._id,
    value: "not_useful",
    comment: "",
  });
  expect(
    (await t.query(internal.repositories.data, { repositoryId: repo._id }))
      .preferences[0].instruction,
  ).toContain("Avoid repeating");
  await t.mutation(api.dashboard.feedback, {
    token,
    findingId: dashboard.findings[0]._id,
    value: "useful",
    comment: "Confirmed authorization bug",
  });
  const preferences = (
    await t.query(internal.repositories.data, { repositoryId: repo._id })
  ).preferences;
  expect(preferences).toHaveLength(1);
  expect(preferences[0].instruction).toContain("accepted finding");
  fixed = true;
  await t.mutation(internal.reviews.enqueue, {
    repositoryId: repo._id,
    prNumber: 1,
    headSha: "c".repeat(40),
    runtimeEvidence: {
      headSha: "c".repeat(40),
      image: "node@sha256:" + "b".repeat(64),
      command: "npm test",
      exitCode: 0,
      timedOut: false,
      executionStarted:true,
      output: 'password="runtime-secret-value"\nRegression passed',
      outputTruncated: false,
      network: "none",
      memoryMb: 512,
      cpus: 1,
    },
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const updated = await t.query(api.dashboard.overview, {
    token,
    organizationId,
  });
  expect(updated.findings[0].status).toBe("resolved");
  expect(updated.reviews[0].runtimeEvidence?.output).toContain("[REDACTED]");
  expect(updated.reviews[0].runtimeEvidence?.output).not.toContain(
    "runtime-secret-value",
  );
  expect(publish).toHaveBeenCalledTimes(4);
  failConversation=true;const repliesBefore=reply.mock.calls.length;
  await expect(t.action(internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:1,commentId:702,author:"author",question:"@openreview explain the current caller",inline:false})).rejects.toThrow("Invalid source citation");
  expect(reply).toHaveBeenCalledTimes(repliesBefore);
  const usage=(await t.query(api.dashboard.overview,{token,organizationId})).usage.filter(u=>u.kind==="conversation");expect(usage.some(u=>u.estimatedCost===0.01&&u.inputTokens===100&&u.outputTokens===50)).toBe(true);
  await t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());expect(reply).toHaveBeenCalledTimes(repliesBefore+1);
});
