/**
 * REST API v1 route table (R6.18, R3.1, R6.19). Every route is tenant-scoped by the caller's org (from the API key or
 * the session, never from input): ids of another org's objects answer 404, exactly like ids that do not exist.
 * `app/api/v1/**` route files bind these specs to Next.js; `lib/api/openapi.ts` documents them.
 */
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getIndexStatus, createIndexJob, cancelIndexJob } from "@/lib/indexer/jobs";
import { getRepoDetail, listRepoOverview } from "@/lib/data/repos";
import { getRepoEffectiveSettings } from "@/lib/data/settings";
import { getReviewDetail, listReviewPage, REVIEW_STATUSES } from "@/lib/data/reviews";
import { searchFindings, FINDING_SORTS, type FindingStatus } from "@/lib/data/findings";
import { FEEDBACK_KINDS, FeedbackError, feedbackCounts, submitFindingFeedback } from "@/lib/data/feedback";
import { createRule, deleteRule, listRules, updateRule, RuleValidationError, type RuleRow } from "@/lib/data/rules";
import { recordAudit } from "@/lib/data/audit";
import { MAX_PAGE, MAX_PAGE_SIZE } from "@/lib/data/paginate";
import { scoped } from "@/lib/data/tenant";
import { findingFeedback, findings, findingStatus, repos } from "@/lib/db/schema";
import { buildFixAllTask, DEFAULT_FIX_ALL_MIN_CONFIDENCE } from "@/lib/fix/fix-all";
import { loadFindingFix } from "@/lib/fix/context";
import { buildFixPrompts, cursorDeepLink, FIX_AGENTS, type FixAgent } from "@/lib/fix/prompt";
import { REVIEW_MODES } from "@/lib/llm/types";
import { getRun } from "@/lib/pipeline/state";
import { cancelReview, requestReview } from "@/lib/pipeline/request";
import { UsageLimitError } from "@/lib/billing/limits";
import { requestMetadata } from "@/lib/auth/sessions";
import { actorLabel, auditActor, type ApiPrincipal } from "./auth";
import { apiJson, apiText, noContent, notFound, paginated, ApiError } from "./http";
import { defineRoute, type AnyRoute, type ApiDeps } from "./router";

// ---- shared schemas

const intId = z.coerce.number().int().positive().max(2_147_483_647);
const idParams = z.object({ id: intId });
const runParams = z.object({ runId: intId });
const pageFields = {
  page: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
};

/** A list filter given as `a,b` or repeated `?x=a&x=b`, each value one of `values`. */
function csvOf<const T extends readonly [string, ...string[]]>(values: T) {
  const item = z.enum(values);
  return z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).max(20));
}

const SEVERITY_VALUES = ["critical", "high", "medium", "low"] as const;
const CATEGORY_VALUES = ["correctness", "security", "data", "api_compat", "testing", "performance", "rules"] as const;

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const paginationSchema = z.object({ page: z.number(), pageSize: z.number(), total: z.number(), pageCount: z.number(), hasMore: z.boolean() });
const object = z.looseObject({});
const listOf = (item: z.ZodType) => z.object({ data: z.array(item), pagination: paginationSchema });

const repositorySchema = z.looseObject({ id: z.number(), fullName: z.string(), enabled: z.boolean(), indexStatus: z.string() });
const reviewSchema = z.looseObject({ id: z.number(), repoFullName: z.string(), prNumber: z.number(), status: z.string() });
const findingSchema = z.looseObject({
  id: z.number(),
  title: z.string(),
  severity: z.string(),
  confidence: z.number(),
  category: z.string(),
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  status: z.string(),
});
const ruleSchema = z.looseObject({ id: z.number(), text: z.string(), paths: z.array(z.string()), status: z.string(), repoId: z.number().nullable() });
const runSchema = z.looseObject({ id: z.number(), reviewId: z.number(), status: z.string(), trigger: z.string() });

const ERRORS = {
  400: { description: "Invalid input (`validation_error` or `bad_request`).", schema: errorSchema },
  401: { description: "Missing, unknown, revoked, or expired API key.", schema: errorSchema },
  403: { description: "The key lacks the scope (`insufficient_scope`), or a cross-origin cookie request (`csrf_failed`).", schema: errorSchema },
  429: { description: "Rate limit exceeded; see `retry-after`.", schema: errorSchema },
};
const NOT_FOUND = { 404: { description: "Not found in your organization.", schema: errorSchema } };

// ---- helpers

async function audit(deps: ApiDeps, req: Request, p: ApiPrincipal, entry: { action: string; targetType: string; targetId: string | number; metadata?: Record<string, unknown> }) {
  await recordAudit(deps.db, { orgId: p.orgId, ...auditActor(p), ...entry, ip: requestMetadata(req).ip, now: deps.now() });
}

async function repoOf(deps: ApiDeps, orgId: string, repoId: number) {
  const [repo] = await deps.db.select().from(repos).where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!repo) throw notFound("Repository");
  return repo;
}

function ruleJson(r: RuleRow, repoFullName: string | null = null) {
  return { ...r, repoFullName };
}

// ---- routes

const me = defineRoute({
  method: "GET",
  path: "/me",
  tag: "Account",
  summary: "Who is calling: the API key (or signed-in user), its organization, and its scopes",
  scope: null,
  responses: { 200: { description: "The caller.", schema: object }, ...ERRORS },
  async handler({ principal: p }) {
    return apiJson({
      organization: { id: p.orgId, name: p.orgName, slug: p.orgSlug },
      scopes: p.scopes,
      ...(p.actor.type === "api_key"
        ? { apiKey: { id: p.actor.keyId, name: p.actor.name, prefix: p.actor.prefix }, user: null }
        : { apiKey: null, user: { id: p.actor.userId, name: p.actor.name, role: p.actor.role } }),
    });
  },
});

const listRepositories = defineRoute({
  method: "GET",
  path: "/repositories",
  tag: "Repositories",
  summary: "List the organization's repositories with index and review state",
  scope: "repos:read",
  query: z.strictObject({ ...pageFields, q: z.string().trim().max(200).optional() }),
  responses: { 200: { description: "A page of repositories.", schema: listOf(repositorySchema) }, ...ERRORS },
  async handler({ deps, principal, query }) {
    return apiJson(paginated(await listRepoOverview(deps.db, principal.orgId, query)));
  },
});

const getRepository = defineRoute({
  method: "GET",
  path: "/repositories/{id}",
  tag: "Repositories",
  summary: "One repository: settings (effective, with their source), index status, and headline stats",
  scope: "repos:read",
  params: idParams,
  responses: { 200: { description: "The repository.", schema: z.object({ repository: repositorySchema }) }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, principal, params }) {
    const detail = await getRepoDetail(deps.db, principal.orgId, params.id);
    if (!detail) throw notFound("Repository");
    const [index, settings] = await Promise.all([getIndexStatus(deps.db, principal.orgId, params.id), getRepoEffectiveSettings(deps.db, principal.orgId, params.id)]);
    const r = detail.repo;
    return apiJson({
      repository: {
        id: r.id,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        private: r.private,
        enabled: r.enabled,
        archived: r.archived,
        indexStatus: r.indexStatus,
        installation: detail.installation,
        reviewMode: detail.reviewMode,
        stats: detail.stats,
        settings: { repository: r.settings, effective: settings?.settings ?? null, sources: settings?.sources ?? null },
        index,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      },
    });
  },
});

const reindexRepository = defineRoute({
  method: "POST",
  path: "/repositories/{id}/reindex",
  tag: "Repositories",
  summary: "Queue a full or incremental re-index of a repository",
  scope: "repos:write",
  params: idParams,
  body: z.strictObject({ mode: z.enum(["full", "incremental"]).default("incremental") }),
  responses: { 202: { description: "The queued index job.", schema: z.object({ indexJob: object }) }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, req, principal, params, body, log }) {
    const repo = await repoOf(deps, principal.orgId, params.id);
    const requestedBy = actorLabel(principal);
    const job = await createIndexJob(deps.db, { orgId: principal.orgId, repoId: repo.id, kind: body.mode, trigger: "api" });
    try {
      await deps.queue.add(
        "index-repo",
        { orgId: principal.orgId, repoId: repo.id, mode: body.mode, trigger: "api", indexJobId: job.id, meta: { requestedBy } },
        { jobId: `index-${repo.id}-api-${job.id}` },
      );
    } catch (err) {
      // Never leave a tracked run queued that no worker will pick up.
      await cancelIndexJob(deps.db, principal.orgId, repo.id, job.id);
      throw err;
    }
    log.info("re-index queued through the API", { repoId: repo.id, indexJobId: job.id, kind: body.mode });
    await audit(deps, req, principal, { action: "repository.reindex_requested", targetType: "repository", targetId: repo.id, metadata: { mode: body.mode, indexJobId: job.id } });
    return apiJson({ indexJob: { id: job.id, repositoryId: repo.id, kind: job.kind, status: job.status, trigger: job.trigger, queuedAt: job.queuedAt } }, 202);
  },
});

const listReviews = defineRoute({
  method: "GET",
  path: "/reviews",
  tag: "Reviews",
  summary: "List pull request reviews, newest activity first",
  scope: "reviews:read",
  query: z.strictObject({ ...pageFields, repositoryId: intId.optional(), status: z.enum(REVIEW_STATUSES).optional(), mode: z.enum(REVIEW_MODES).optional() }),
  responses: { 200: { description: "A page of reviews.", schema: listOf(reviewSchema) }, ...ERRORS },
  async handler({ deps, principal, query }) {
    const page = await listReviewPage(deps.db, principal.orgId, {
      page: query.page,
      pageSize: query.pageSize,
      repoId: query.repositoryId,
      status: query.status,
      mode: query.mode,
    });
    return apiJson(paginated(page));
  },
});

const getReview = defineRoute({
  method: "GET",
  path: "/reviews/{id}",
  tag: "Reviews",
  summary: "One review: pull request, summary, runs (with stage timings and cost), and findings",
  scope: "reviews:read",
  params: idParams,
  responses: { 200: { description: "The review.", schema: z.object({ review: reviewSchema }) }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, principal, params }) {
    const review = await getReviewDetail(deps.db, principal.orgId, params.id, { findingsLimit: 200, rejectedLimit: 50 });
    if (!review) throw notFound("Review");
    return apiJson({ review });
  },
});

const createReview = defineRoute({
  method: "POST",
  path: "/reviews",
  tag: "Reviews",
  summary: "Request a review of a pull request",
  description: "Queues a review run (trigger `api`). A newer run of the same pull request supersedes older queued or running ones.",
  scope: "reviews:write",
  body: z.strictObject({
    repositoryId: intId,
    prNumber: z.number().int().positive().max(2_147_483_647),
    mode: z.enum(REVIEW_MODES).optional(),
    focus: z.enum(["security"]).optional(),
    /** Review everything again, ignoring the incremental baseline. */
    full: z.boolean().optional(),
  }),
  responses: { 202: { description: "The queued run.", schema: z.object({ run: runSchema }) }, 402: { description: "A usage cap or plan limit was reached (`usage_limit`); nothing was queued.", schema: errorSchema }, 409: { description: "The repository is archived.", schema: errorSchema }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, req, principal, body, log }) {
    const repo = await repoOf(deps, principal.orgId, body.repositoryId);
    if (repo.archived) throw new ApiError(409, "conflict", "The repository is archived on GitHub and can't be reviewed.");
    const requestedBy = actorLabel(principal);
    const requested = await requestReview(
      { db: deps.db, queue: deps.queue, log },
      {
        orgId: principal.orgId,
        repoId: repo.id,
        prNumber: body.prNumber,
        trigger: "api",
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.focus ? { focus: body.focus } : {}),
        full: body.full ?? false,
        requestedBy,
        meta: { requestedBy },
      },
    ).catch((err: unknown) => {
      // Over a usage cap or plan limit (R4.3, R4.2): nothing was queued.
      if (err instanceof UsageLimitError) throw new ApiError(402, "usage_limit", err.message, { reason: err.code, periodEnd: err.period.end.toISOString() });
      throw err;
    });
    await audit(deps, req, principal, {
      action: "review.requested",
      targetType: "review",
      targetId: requested.reviewId,
      metadata: { runId: requested.runId, repositoryId: repo.id, prNumber: body.prNumber, mode: body.mode ?? null, focus: body.focus ?? null, full: body.full ?? false },
    });
    const run = await getRun(deps.db, { orgId: principal.orgId, runId: requested.runId });
    return apiJson(
      {
        run: {
          id: requested.runId,
          reviewId: requested.reviewId,
          repositoryId: repo.id,
          prNumber: body.prNumber,
          status: run?.status ?? "queued",
          trigger: run?.trigger ?? "api",
          mode: run?.mode ?? null,
          focus: run?.focus ?? null,
          full: run?.full ?? false,
          requestedBy,
          queuedAt: run?.queuedAt ?? deps.now(),
          deduped: requested.deduped,
        },
      },
      202,
    );
  },
});

const cancelRun = defineRoute({
  method: "POST",
  path: "/reviews/runs/{runId}/cancel",
  tag: "Reviews",
  summary: "Cancel a queued or running review run",
  scope: "reviews:write",
  params: runParams,
  responses: {
    200: { description: "The run was cancelled (`cancelled`) or will stop at its next stage (`cancel_requested`).", schema: object },
    409: { description: "The run had already finished.", schema: errorSchema },
    ...ERRORS,
    ...NOT_FOUND,
  },
  async handler({ deps, req, principal, params, log }) {
    const outcome = await cancelReview(deps.db, principal.orgId, params.runId, actorLabel(principal), log);
    if (outcome.status === "not_found") throw notFound("Review run");
    if (outcome.status === "already_finished") throw new ApiError(409, "conflict", `The run already finished (${outcome.runStatus}).`);
    await audit(deps, req, principal, { action: "review.cancelled", targetType: "review_run", targetId: params.runId, metadata: { outcome: outcome.status } });
    return apiJson({ runId: params.runId, status: outcome.status });
  },
});

const listFindings = defineRoute({
  method: "GET",
  path: "/findings",
  tag: "Findings",
  summary: "Search published findings",
  scope: "findings:read",
  query: z.strictObject({
    ...pageFields,
    repositoryId: intId.optional(),
    reviewId: intId.optional(),
    status: csvOf(findingStatus.enumValues).optional(),
    severity: csvOf(SEVERITY_VALUES).optional(),
    category: csvOf(CATEGORY_VALUES).optional(),
    sort: z.enum(FINDING_SORTS).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
  }),
  responses: { 200: { description: "A page of findings.", schema: listOf(findingSchema) }, ...ERRORS },
  async handler({ deps, principal, query }) {
    const page = await searchFindings(deps.db, principal.orgId, {
      page: query.page,
      pageSize: query.pageSize,
      repoId: query.repositoryId,
      reviewId: query.reviewId,
      status: query.status as FindingStatus[] | undefined,
      severity: query.severity,
      category: query.category,
      sort: query.sort,
      dir: query.dir,
    });
    return apiJson(paginated(page));
  },
});

async function findingOr404(deps: ApiDeps, orgId: string, findingId: number) {
  const [row] = await deps.db
    .select({ finding: findings, repoFullName: repos.fullName })
    .from(findings)
    .innerJoin(repos, and(eq(repos.id, findings.repoId), eq(repos.orgId, orgId)))
    .where(scoped(findings, orgId, eq(findings.id, findingId), ne(findings.visibility, "rejected")));
  if (!row) throw notFound("Finding");
  return row;
}

const getFinding = defineRoute({
  method: "GET",
  path: "/findings/{id}",
  tag: "Findings",
  summary: "One finding with its evidence, suggested fix, and feedback counts",
  scope: "findings:read",
  params: idParams,
  responses: { 200: { description: "The finding.", schema: z.object({ finding: findingSchema }) }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, principal, params }) {
    const row = await findingOr404(deps, principal.orgId, params.id);
    const feedback = await feedbackCounts(deps.db, principal.orgId, row.finding.id);
    return apiJson({ finding: { ...row.finding, repoFullName: row.repoFullName, feedback } });
  },
});

const feedbackOnFinding = defineRoute({
  method: "POST",
  path: "/findings/{id}/feedback",
  tag: "Findings",
  summary: "Give feedback on a finding (useful, not useful, resolved, won't fix, false positive)",
  description: "Resolved, won't fix, and false positive also change the finding's status; useful, not useful, and false positive teach the learned preferences.",
  scope: "findings:write",
  params: idParams,
  body: z.strictObject({ kind: z.enum(FEEDBACK_KINDS), note: z.string().max(4000).optional() }),
  responses: {
    201: { description: "Feedback recorded.", schema: object },
    200: { description: "The same feedback was already recorded (nothing changed).", schema: object },
    ...ERRORS,
    ...NOT_FOUND,
  },
  async handler({ deps, principal, params, body }) {
    const orgId = principal.orgId;
    const finding = await findingOr404(deps, orgId, params.id);
    if (principal.actor.type === "api_key") {
      // API keys are not users: one piece of feedback of each kind per key and finding.
      const author = actorLabel(principal);
      const [existing] = await deps.db
        .select({ id: findingFeedback.id, patternId: findingFeedback.patternId })
        .from(findingFeedback)
        .where(
          scoped(
            findingFeedback,
            orgId,
            eq(findingFeedback.findingId, params.id),
            eq(findingFeedback.source, "api"),
            eq(findingFeedback.externalAuthor, author),
            eq(findingFeedback.kind, body.kind),
          ),
        )
        .limit(1);
      if (existing) {
        return apiJson({
          feedbackId: existing.id,
          duplicate: true,
          finding: { id: finding.finding.id, status: finding.finding.status, resolution: finding.finding.resolution },
          counts: await feedbackCounts(deps.db, orgId, params.id),
          patternId: existing.patternId,
        });
      }
    }
    try {
      const result = await submitFindingFeedback(deps.db, {
        orgId,
        findingId: params.id,
        ...(principal.actor.type === "user" ? { userId: principal.actor.userId } : { externalAuthor: actorLabel(principal) }),
        source: "api",
        kind: body.kind,
        note: body.note ?? null,
        now: deps.now(),
      });
      return apiJson(result, result.duplicate ? 200 : 201);
    } catch (err) {
      if (err instanceof FeedbackError) throw notFound("Finding");
      throw err;
    }
  },
});

const FIX_AGENT_QUERY = z.enum(FIX_AGENTS);

const fixPrompt = defineRoute({
  method: "GET",
  path: "/findings/{id}/fix-prompt",
  tag: "Fix with AI",
  summary: "A ready-to-paste coding-agent prompt that fixes one finding",
  description:
    "Variants for Claude Code, Cursor, and Codex share one body and differ only in their header. `format=text` returns the chosen agent's prompt as plain text.",
  scope: "findings:read",
  params: idParams,
  query: z.strictObject({ agent: FIX_AGENT_QUERY.default("claude-code"), format: z.enum(["json", "text"]).default("json") }),
  responses: {
    200: { description: "The prompt and its variants.", schema: z.object({ findingId: z.number(), agent: z.string(), prompt: z.string(), variants: object }) },
    ...ERRORS,
    ...NOT_FOUND,
  },
  async handler({ deps, principal, params, query, log }) {
    const loaded = await loadFindingFix(deps.db, principal.orgId, params.id, { ...(deps.readFile ? { readFile: deps.readFile } : {}), log });
    if (!loaded) throw notFound("Finding");
    const set = buildFixPrompts(loaded.fix, loaded.ctx);
    const agent: FixAgent = query.agent;
    const prompt = set.variants[agent];
    if (query.format === "text") return apiText(prompt, "text/plain; charset=utf-8");
    return apiJson({
      findingId: loaded.finding.id,
      agent,
      prompt,
      body: set.body,
      headers: set.headers,
      variants: set.variants,
      cursorDeepLink: cursorDeepLink(set.variants.cursor),
    });
  },
});

const fixAll = defineRoute({
  method: "GET",
  path: "/reviews/{id}/fix-all",
  tag: "Fix with AI",
  summary: "One coding-agent task that fixes every unresolved finding of a review at or above a confidence threshold",
  description: "Ordered by severity, then file and line, with a checklist and verification steps. `format=md` downloads the task as Markdown.",
  scope: "findings:read",
  params: idParams,
  query: z.strictObject({
    minConfidence: z.coerce.number().min(0).max(1).default(DEFAULT_FIX_ALL_MIN_CONFIDENCE),
    format: z.enum(["json", "md"]).default("json"),
  }),
  responses: {
    200: { description: "The task (JSON, or Markdown with `format=md`).", schema: z.object({ task: z.looseObject({ markdown: z.string(), findings: z.array(object) }) }) },
    ...ERRORS,
    ...NOT_FOUND,
  },
  async handler({ deps, principal, params, query }) {
    const task = await buildFixAllTask(deps.db, principal.orgId, params.id, { minConfidence: query.minConfidence });
    if (!task) throw notFound("Review");
    if (query.format === "md") {
      return apiText(task.markdown, "text/markdown; charset=utf-8", { "content-disposition": `attachment; filename="${task.filename}"` });
    }
    return apiJson({ task });
  },
});

const ruleStatusValues = ["active", "candidate", "rejected"] as const;
const rulePaths = z.array(z.string().trim().min(1).max(500)).max(50);

const listRulesRoute = defineRoute({
  method: "GET",
  path: "/rules",
  tag: "Rules",
  summary: "List review rules (org-wide and per repository)",
  scope: "rules:read",
  query: z.strictObject({ status: csvOf(ruleStatusValues).optional(), repositoryId: intId.optional() }),
  responses: { 200: { description: "The rules.", schema: z.object({ data: z.array(ruleSchema) }) }, ...ERRORS },
  async handler({ deps, principal, query }) {
    const rows = await listRules(deps.db, principal.orgId, { ...(query.status?.length ? { status: query.status } : {}), ...(query.repositoryId ? { repoId: query.repositoryId } : {}) });
    return apiJson({ data: rows.map((r) => ruleJson(r.rule, r.repoFullName)) });
  },
});

const createRuleRoute = defineRoute({
  method: "POST",
  path: "/rules",
  tag: "Rules",
  summary: "Create a review rule",
  scope: "rules:write",
  body: z.strictObject({ text: z.string().trim().min(5).max(2000), repositoryId: intId.nullable().optional(), paths: rulePaths.optional() }),
  responses: { 201: { description: "The rule.", schema: z.object({ rule: ruleSchema }) }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, req, principal, body }) {
    if (body.repositoryId != null) await repoOf(deps, principal.orgId, body.repositoryId);
    try {
      const rule = await createRule(deps.db, principal.orgId, {
        text: body.text,
        repoId: body.repositoryId ?? null,
        paths: body.paths ?? [],
        source: "api",
        createdBy: actorLabel(principal),
      });
      await audit(deps, req, principal, { action: "rule.created", targetType: "rule", targetId: rule.id, metadata: { repositoryId: rule.repoId } });
      return apiJson({ rule: ruleJson(rule) }, 201);
    } catch (err) {
      if (err instanceof RuleValidationError) throw new ApiError(400, "validation_error", err.message);
      throw err;
    }
  },
});

const updateRuleRoute = defineRoute({
  method: "PATCH",
  path: "/rules/{id}",
  tag: "Rules",
  summary: "Edit a review rule (text, paths, repository, or status)",
  scope: "rules:write",
  params: idParams,
  body: z
    .strictObject({
      text: z.string().trim().min(5).max(2000).optional(),
      paths: rulePaths.optional(),
      repositoryId: intId.nullable().optional(),
      status: z.enum(["active", "rejected"]).optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Send at least one field to change." }),
  responses: { 200: { description: "The updated rule.", schema: z.object({ rule: ruleSchema }) }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, req, principal, params, body }) {
    if (body.repositoryId != null) await repoOf(deps, principal.orgId, body.repositoryId);
    try {
      const rule = await updateRule(deps.db, principal.orgId, params.id, {
        ...(body.text !== undefined ? { text: body.text } : {}),
        ...(body.paths !== undefined ? { paths: body.paths } : {}),
        ...(body.repositoryId !== undefined ? { repoId: body.repositoryId } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      if (!rule) throw notFound("Rule");
      await audit(deps, req, principal, { action: "rule.updated", targetType: "rule", targetId: rule.id, metadata: { fields: Object.keys(body) } });
      return apiJson({ rule: ruleJson(rule) });
    } catch (err) {
      if (err instanceof RuleValidationError) throw new ApiError(400, "validation_error", err.message);
      throw err;
    }
  },
});

const deleteRuleRoute = defineRoute({
  method: "DELETE",
  path: "/rules/{id}",
  tag: "Rules",
  summary: "Delete a review rule",
  scope: "rules:write",
  params: idParams,
  responses: { 204: { description: "Deleted." }, ...ERRORS, ...NOT_FOUND },
  async handler({ deps, req, principal, params }) {
    if (!(await deleteRule(deps.db, principal.orgId, params.id))) throw notFound("Rule");
    await audit(deps, req, principal, { action: "rule.deleted", targetType: "rule", targetId: params.id });
    return noContent();
  },
});

const openapi = defineRoute({
  method: "GET",
  path: "/openapi.json",
  tag: "Meta",
  summary: "This API's OpenAPI 3.1 document",
  scope: null,
  public: true,
  responses: { 200: { description: "The OpenAPI document.", schema: object } },
  async handler({ deps }) {
    // Imported lazily: the document is built from this table.
    const { openApiDocument } = await import("./openapi");
    return apiJson(openApiDocument(deps.appUrl));
  },
});

/** Every v1 route. The route files under `app/api/v1` bind these by `"<METHOD> <path>"`. */
export const V1_ROUTES: readonly AnyRoute[] = [
  me,
  listRepositories,
  getRepository,
  reindexRepository,
  listReviews,
  createReview,
  getReview,
  cancelRun,
  fixAll,
  listFindings,
  getFinding,
  feedbackOnFinding,
  fixPrompt,
  listRulesRoute,
  createRuleRoute,
  updateRuleRoute,
  deleteRuleRoute,
  openapi,
] as AnyRoute[];

export const V1_BASE_PATH = "/api/v1";
