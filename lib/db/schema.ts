import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Embedding width stored in pgvector. Shorter provider vectors are zero-padded (cosine-preserving). */
export const EMBEDDING_DIM = 1536;

const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? EMBEDDING_DIM})`;
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map(Number);
  },
});

/**
 * Review settings (R6.14), stored per org (`orgs.settings`) and per repo (`repos.settings`); `openreview.json`
 * overrides both key by key. Every key is optional: an absent key falls through to the next layer or the default.
 * Validated by `reviewSettingsSchema` in `lib/config/settings.ts`.
 */
export interface RepoSettings {
  autoReview?: boolean;
  reviewDrafts?: boolean;
  /** Base branches (globs) that are reviewed automatically; empty or absent = all. */
  targetBranches?: string[];
  /** PRs whose head or base branch matches one of these globs are not reviewed automatically. */
  ignoredBranches?: string[];
  ignore?: string[];
  maxComments?: number;
  /** 0..1 */
  minConfidence?: number;
  minSeverity?: "critical" | "high" | "medium" | "low";
  /** Reviewer agents (finding categories) to run. */
  categories?: ("correctness" | "security" | "data" | "api_compat" | "testing" | "performance" | "rules")[];
  /** Legacy category switch; `categories` wins when both are set. */
  commentTypes?: ("logic" | "security" | "style")[];
  model?: string;
  mode?: "fast" | "standard" | "deep";
  customInstructions?: string;
  autoReReview?: boolean;
  commentStyle?: "concise" | "detailed";
  /** Preset for minConfidence / maxComments / minSeverity when those are not set explicitly. */
  strictness?: "low" | "medium" | "high";
  context?: string[];
}

/** Org-wide review defaults (R6.14); same shape as repo settings, which override them. */
export type OrgSettings = RepoSettings;

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * An organization (workspace). Every tenant-owned row references this id; new ids are `org_` + a random token.
 * Every user has one `personal` workspace (R6.1). `slug` is derived from the name when the app creates the org;
 * rows inserted without one (the install flow's upsert, rows from before built-in auth) get a random `org-…` slug
 * from the column default.
 */
export const orgs = pgTable(
  "orgs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug")
      .notNull()
      .default(sql`('org-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12))`),
    personal: boolean("personal").notNull().default(false),
    /** Org-wide review setting defaults (R6.14); repo settings and openreview.json override them key by key. */
    settings: jsonb("settings").$type<OrgSettings>().notNull().default({}),
    /** When someone finished the onboarding wizard (R6.2); every other wizard step is derived from data. */
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    createdBy: text("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("orgs_slug_uq").on(t.slug),
    // At most one personal workspace per user.
    uniqueIndex("orgs_personal_creator_uq").on(t.createdBy).where(sql`${t.personal}`),
  ],
);

/** A GitHub App installation, owned by exactly one org (R1.1). */
export const installations = pgTable(
  "installations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    /** `User` or `Organization` (GitHub may also report `Enterprise`). */
    accountType: text("account_type"),
    suspended: boolean("suspended").notNull().default(false),
    /** `all` or `selected`, as chosen on GitHub. */
    repositorySelection: text("repository_selection"),
    /** Permissions GitHub reports the app holds on this installation, e.g. `{ "pull_requests": "write" }`. */
    permissions: jsonb("permissions").$type<Record<string, string>>().notNull().default({}),
    /** Required permissions the installation lacks (`pull_requests:write`, ...); empty when healthy. */
    missingPermissions: text("missing_permissions").array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("installations_provider_external_uq").on(t.provider, t.externalId), index().on(t.orgId)],
);

export const indexStatus = pgEnum("index_status", ["pending", "indexing", "ready", "failed"]);

export const repos = pgTable(
  "repos",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    private: boolean("private").notNull().default(true),
    /** Whether the org has reviews enabled for this repo. */
    enabled: boolean("enabled").notNull().default(true),
    /** Archived on GitHub: read-only and never reviewed. Unarchiving does not re-enable reviews. */
    archived: boolean("archived").notNull().default(false),
    indexStatus: indexStatus("index_status").notNull().default("pending"),
    indexError: text("index_error"),
    indexedSha: text("indexed_sha"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    fileCount: integer("file_count").notNull().default(0),
    symbolCount: integer("symbol_count").notNull().default(0),
    /** Indexed source files per programming language (R6.3). */
    languages: jsonb("languages").$type<Record<string, number>>().notNull().default({}),
    /** Most recent index run (R6.3). */
    lastIndexJobId: integer("last_index_job_id").references((): AnyPgColumn => indexJobs.id, { onDelete: "set null" }),
    /** Dashboard review settings; a repo's openreview.json overrides them key by key (R2.2). */
    settings: jsonb("settings").$type<RepoSettings>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("repos_installation_external_uq").on(t.installationId, t.externalId), index().on(t.orgId)],
);

export const deliveryStatus = pgEnum("delivery_status", ["processing", "accepted", "ignored", "failed"]);

/**
 * Every verified webhook delivery and its outcome (R1.2, R6.21). The delivery id makes redelivery idempotent.
 * `payload` is kept (redacted, at most 1 MB) only while a delivery is failed, so it can be replayed.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    event: text("event").notNull(),
    action: text("action"),
    /** The git host's installation id (not `installations.id`). */
    installationId: bigint("installation_id", { mode: "number" }),
    /** Owning org, once the installation is linked to one. */
    orgId: text("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    /** The repository the event was about. Not a foreign key: the record outlives a deleted repository. */
    repoId: integer("repo_id"),
    repoFullName: text("repo_full_name"),
    status: deliveryStatus("status").notNull().default("processing"),
    reason: text("reason"),
    jobs: text("jobs").array().notNull().default([]),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    payloadSha256: text("payload_sha256"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Start of the latest processing attempt; a `processing` row older than the in-flight window is stale. */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [index().on(t.orgId, t.receivedAt), index().on(t.status, t.receivedAt)],
);

/** Indexed source files at the repo's indexed sha (R1.3). */
export const files = pgTable(
  "files",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    language: text("language").notNull(),
    contentHash: text("content_hash").notNull(),
    /** Classification (R6.3): source, test, config, manifest, schema, migration, route, doc, ci, instructions, generated. */
    tags: text("tags").array().notNull().default([]),
    sizeBytes: integer("size_bytes").notNull().default(0),
    lineCount: integer("line_count").notNull().default(0),
  },
  (t) => [uniqueIndex("files_repo_path_uq").on(t.repoId, t.path), index().on(t.orgId), index("files_tags_gin").using("gin", t.tags)],
);

export const symbols = pgTable(
  "symbols",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * function, method, class, interface, type, enum, struct, trait, variable (exported only), module, route, table,
     * model, test, ci_job (R6.4).
     */
    kind: text("kind").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    /** Source of the symbol (truncated); the chunk that is embedded and shown to reviewers. */
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    /** Enclosing symbol (method -> class). */
    parentId: integer("parent_id").references((): AnyPgColumn => symbols.id, { onDelete: "set null" }),
    exported: boolean("exported").notNull().default(false),
    /** First line of the definition. */
    signature: text("signature"),
    /** Name qualified by its parents, e.g. `Cart.total`. */
    qualifiedName: text("qualified_name"),
  },
  (t) => [
    index().on(t.repoId, t.name),
    index().on(t.fileId),
    index().on(t.orgId),
    index().on(t.repoId, t.kind),
    index().on(t.repoId, t.qualifiedName),
  ],
);

/**
 * Graph relations (R6.4): call, import, export (re-exports), reference, extends, implements, depends_on (module ->
 * module / external package), tested_by (source file -> test file), route_handler (route -> handler symbol),
 * schema_consumer (table/model -> consuming file or symbol).
 */
export const edgeKind = pgEnum("edge_kind", [
  "call",
  "import",
  "export",
  "reference",
  "extends",
  "implements",
  "depends_on",
  "tested_by",
  "route_handler",
  "schema_consumer",
]);
export type EdgeKind = (typeof edgeKind.enumValues)[number];

/**
 * Graph edges. `call` edges go symbol → symbol (target resolved by name);
 * `import` edges go file → file (target resolved by path). Unresolved targets keep
 * their raw name so they can be resolved after later incremental indexing.
 */
export const edges = pgTable(
  "edges",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    kind: edgeKind("kind").notNull(),
    fromFileId: integer("from_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    fromSymbolId: integer("from_symbol_id").references(() => symbols.id, { onDelete: "cascade" }),
    targetName: text("target_name").notNull(),
    toFileId: integer("to_file_id").references(() => files.id, { onDelete: "set null" }),
    toSymbolId: integer("to_symbol_id").references(() => symbols.id, { onDelete: "set null" }),
    line: integer("line").notNull(),
  },
  (t) => [
    index().on(t.repoId, t.kind, t.toSymbolId),
    index().on(t.repoId, t.kind, t.toFileId),
    index().on(t.repoId, t.kind, t.fromFileId),
    index().on(t.repoId, t.targetName),
    index().on(t.fromSymbolId),
    index().on(t.orgId),
  ],
);

export const reviewStatus = pgEnum("review_status", ["queued", "running", "completed", "failed", "skipped", "cancelled"]);

/** One row per PR; re-reviews on new commits update it in place (R1.6). */
export const reviews = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    prTitle: text("pr_title").notNull().default(""),
    prAuthor: text("pr_author").notNull().default(""),
    headSha: text("head_sha").notNull(),
    status: reviewStatus("status").notNull().default("queued"),
    error: text("error"),
    riskLevel: text("risk_level"),
    confidence: integer("confidence"),
    summary: text("summary"),
    summaryCommentId: bigint("summary_comment_id", { mode: "number" }),
    commentCount: integer("comment_count").notNull().default(0),
    creditsUsed: integer("credits_used").notNull().default(0),
    runs: integer("runs").notNull().default(0),
    usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number }>(),
    /** The tracked pull request (R6.6); set once the first run ingests it. */
    pullRequestId: integer("pull_request_id").references((): AnyPgColumn => pullRequests.id, { onDelete: "set null" }),
    /** Most recent run requested for this PR (any status). */
    lastRunId: integer("last_run_id").references((): AnyPgColumn => reviewRuns.id, { onDelete: "set null" }),
    /** Review mode of the latest run (fast | standard | deep). */
    mode: text("mode").notNull().default("standard"),
    /** Published findings still open / resolved by later commits (R6.9). */
    openFindings: integer("open_findings").notNull().default(0),
    resolvedFindings: integer("resolved_findings").notNull().default(0),
    /** Estimated model cost of every completed run, USD (R6.16). Unpriced calls are not counted. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("reviews_repo_pr_uq").on(t.repoId, t.prNumber), index().on(t.orgId, t.createdAt), index().on(t.orgId, t.updatedAt)],
);

/** Inline comments posted to a PR. `fingerprint` dedupes across re-reviews (R1.6). */
export const reviewComments = pgTable(
  "review_comments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    reviewId: integer("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    line: integer("line").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** Custom rule this comment enforces, if any (R2.1). */
    ruleId: text("rule_id"),
    externalId: bigint("external_id", { mode: "number" }),
    headSha: text("head_sha").notNull(),
    /** The finding this comment published (R6.9). */
    findingId: integer("finding_id").references((): AnyPgColumn => findings.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("review_comments_review_fp_uq").on(t.reviewId, t.fingerprint), index().on(t.orgId)],
);

/** Answers to `@openreview` mentions (R1.7). */
export const mentionReplies = pgTable(
  "mention_replies",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    sourceCommentId: bigint("source_comment_id", { mode: "number" }).notNull(),
    /** Which id sequence `source_comment_id` belongs to: `issue_comment`, `review_comment`, or `review`. */
    sourceKind: text("source_kind").notNull().default("issue_comment"),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    replyCommentId: bigint("reply_comment_id", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mention_replies_source_uq").on(t.repoId, t.sourceKind, t.sourceCommentId)],
);

export const ruleStatus = pgEnum("rule_status", ["active", "candidate", "rejected"]);
/** What a rule is about (R6.11); the same names as the reviewer categories, plus `style`. */
export const ruleCategory = pgEnum("rule_category", ["correctness", "security", "data", "api_compat", "testing", "performance", "rules", "style"]);
export const ruleSeverity = pgEnum("rule_severity", ["critical", "high", "medium", "low"]);

/**
 * Plain-English review rules (R2.1, R6.11), org-wide (`repoId` null) or per repo, optionally limited to glob
 * `paths`. Mined candidates (R2.5) start as `candidate` until approved. `severity` is the default (and minimum)
 * severity of a finding that cites the rule; `instructions` add context and examples; a disabled rule is kept but
 * never sent to reviews.
 */
export const rules = pgTable(
  "rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").references(() => repos.id, { onDelete: "cascade" }),
    /** Short name shown in the dashboard; empty for rules written before titles existed (the text is shown). */
    title: text("title").notNull().default(""),
    text: text("text").notNull(),
    category: ruleCategory("category").notNull().default("rules"),
    severity: ruleSeverity("severity").notNull().default("medium"),
    enabled: boolean("enabled").notNull().default(true),
    instructions: text("instructions").notNull().default(""),
    paths: text("paths").array().notNull().default([]),
    status: ruleStatus("status").notNull().default("active"),
    source: text("source").notNull().default("dashboard"),
    rationale: text("rationale"),
    evidence: jsonb("evidence").$type<{ commentId: number; author: string; excerpt: string }[]>(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId, t.status), index().on(t.repoId)],
);

export const feedbackKind = pgEnum("feedback_kind", ["thumbs_up", "thumbs_down", "reply"]);
export const patternSignal = pgEnum("pattern_signal", ["suppress", "boost", "neutral"]);
/** `pattern`: matches findings by category and title. `category`: applies to every finding of a category (R6.10). */
export const preferenceKind = pgEnum("preference_kind", ["pattern", "category"]);
export const preferenceScope = pgEnum("preference_scope", ["org", "repo"]);
/** Where a learned preference came from (R6.10). */
export const preferenceSource = pgEnum("preference_source", ["feedback", "reply", "command", "human_rule"]);

/**
 * Learned preferences (R2.4, R6.10): conventions inferred from feedback on OpenReview findings. `suppress` patterns
 * stop recurring; `boost` patterns are prioritized. Category preferences (`kind = category`) raise the confidence bar
 * for a category the team rarely finds useful (`confidenceDelta`) or prioritize one it values. Users can edit the
 * description and signal (`userEdited` pins the preference against later feedback and resets) or delete it.
 */
export const learnedPatterns = pgTable(
  "learned_patterns",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").references(() => repos.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    description: text("description").notNull(),
    signal: patternSignal("signal").notNull().default("neutral"),
    positive: integer("positive").notNull().default(0),
    negative: integer("negative").notNull().default(0),
    examples: jsonb("examples").$type<{ title: string; path: string }[]>().notNull().default([]),
    userEdited: boolean("user_edited").notNull().default(false),
    kind: preferenceKind("kind").notNull().default("pattern"),
    /** `org` preferences have no repo; `repo` preferences apply to `repoId` only. */
    scope: preferenceScope("scope").notNull().default("repo"),
    source: preferenceSource("source").notNull().default("feedback"),
    /** Added to the minimum confidence for findings this preference covers (category suppressions). */
    confidenceDelta: real("confidence_delta").notNull().default(0),
    /** Signals (feedback rows) folded into this preference. */
    evidenceCount: integer("evidence_count").notNull().default(0),
    lastSignalAt: timestamp("last_signal_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.orgId, t.repoId),
    // One category preference per repository and category.
    uniqueIndex("learned_patterns_category_uq").on(t.repoId, t.category).where(sql`${t.kind} = 'category'`),
  ],
);

/** One reaction or reply on a OpenReview inline comment (R2.4). */
export const commentFeedback = pgTable(
  "comment_feedback",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    reviewCommentId: integer("review_comment_id")
      .notNull()
      .references(() => reviewComments.id, { onDelete: "cascade" }),
    kind: feedbackKind("kind").notNull(),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    author: text("author").notNull(),
    body: text("body"),
    sentiment: integer("sentiment").notNull(),
    patternId: integer("pattern_id").references(() => learnedPatterns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("comment_feedback_uq").on(t.reviewCommentId, t.kind, t.externalId), index().on(t.orgId)],
);

/** Inline review comments written by teammates, mined into candidate rules (R2.5). */
export const humanReviewComments = pgTable(
  "human_review_comments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    author: text("author").notNull(),
    path: text("path").notNull(),
    body: text("body").notNull(),
    minedAt: timestamp("mined_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("human_review_comments_uq").on(t.repoId, t.externalId), index().on(t.orgId, t.repoId, t.minedAt)],
);

// ---- github ----

/**
 * GitHub App installations not linked to an org yet (R1.1), recorded from the `installation.created` webhook so
 * onboarding can offer them. Claiming one links it to an org (the caller verifies the user's access) and deletes the
 * row. Not tenant-owned: there is no org until it is claimed.
 */
export const pendingInstallations = pgTable(
  "pending_installations",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull().default("github"),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    /** `User` or `Organization`. */
    accountType: text("account_type").notNull(),
    /** The GitHub user who installed the app. */
    senderLogin: text("sender_login").notNull(),
    senderId: bigint("sender_id", { mode: "number" }),
    permissions: jsonb("permissions").$type<Record<string, string>>().notNull().default({}),
    repositorySelection: text("repository_selection"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pending_installations_provider_external_uq").on(t.provider, t.externalId)],
);

// ---- indexer (R6.3 / R6.4) ----

export const indexJobKind = pgEnum("index_job_kind", ["full", "incremental"]);
export const indexJobTrigger = pgEnum("index_job_trigger", ["install", "push", "manual", "schedule", "api"]);
export const indexJobStatus = pgEnum("index_job_status", ["queued", "running", "completed", "failed", "cancelled"]);

export type IndexPhase = "queued" | "checkout" | "scan" | "parse" | "embed" | "graph" | "finalize" | "done";

export interface IndexProgress {
  phase: IndexPhase;
  /** Files that pass the skip rules at the indexed commit. */
  filesTotal: number;
  /** Changed files processed so far in the parse phase. */
  filesDone: number;
  filesChanged: number;
  filesRemoved: number;
  filesSkipped: Record<string, number>;
  symbols: number;
  edges: number;
  /** Symbols and doc chunks embedded so far in the embed phase (absent before it starts). */
  embedded?: number;
  /** Lines replaced with `[REDACTED SECRET]` in this run. */
  secretLinesRedacted: number;
}

export const EMPTY_INDEX_PROGRESS: IndexProgress = {
  phase: "queued",
  filesTotal: 0,
  filesDone: 0,
  filesChanged: 0,
  filesRemoved: 0,
  filesSkipped: {},
  symbols: 0,
  edges: 0,
  secretLinesRedacted: 0,
};

/** One index run of a repository: state, progress, retries, and changed files (R6.3). */
export const indexJobs = pgTable(
  "index_jobs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    kind: indexJobKind("kind").notNull(),
    trigger: indexJobTrigger("trigger").notNull(),
    status: indexJobStatus("status").notNull().default("queued"),
    /** Previously indexed commit (null for a first index). */
    fromSha: text("from_sha"),
    /** Commit being indexed (the requested sha until checkout resolves it). */
    toSha: text("to_sha"),
    /** Queue job id, so retries of one queued job update the same row. */
    queueJobId: text("queue_job_id"),
    attempts: integer("attempts").notNull().default(0),
    progress: jsonb("progress").$type<IndexProgress>().notNull().default(EMPTY_INDEX_PROGRESS),
    /** Added, modified, and removed paths (first 500). */
    changedFiles: text("changed_files").array().notNull().default([]),
    error: text("error"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.repoId, t.id), index().on(t.repoId, t.queueJobId)],
);

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const chunkKind = pgEnum("chunk_kind", ["code", "doc", "config"]);

/**
 * Retrieval chunks (R6.3): code by symbol-aligned line windows, docs by heading, config by top-level keys. All are
 * full-text searchable through `tsv`; doc chunks are also embedded.
 */
export const fileChunks = pgTable(
  "file_chunks",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    kind: chunkKind("kind").notNull(),
    content: text("content").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', "content")`),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
  },
  (t) => [
    index("file_chunks_tsv_gin").using("gin", t.tsv),
    index().on(t.repoId, t.path),
    index().on(t.fileId),
    index().on(t.orgId),
  ],
);

export const dependencyEcosystem = pgEnum("dependency_ecosystem", ["npm", "pypi", "go", "cargo", "maven", "nuget", "rubygems"]);
export const dependencyKind = pgEnum("dependency_kind", ["prod", "dev", "peer", "build", "optional"]);

/** Dependencies declared in package manifests (R6.3). Rows go with their manifest file. */
export const repoDependencies = pgTable(
  "repo_dependencies",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    manifestPath: text("manifest_path").notNull(),
    ecosystem: dependencyEcosystem("ecosystem").notNull(),
    name: text("name").notNull(),
    versionSpec: text("version_spec"),
    kind: dependencyKind("kind").notNull(),
  },
  (t) => [
    uniqueIndex("repo_dependencies_uq").on(t.repoId, t.manifestPath, t.ecosystem, t.name, t.kind),
    index().on(t.repoId, t.name),
    index().on(t.orgId),
  ],
);

/** Recent commits of the indexed ref with the paths they touched (R6.3), for "recently changed" context. */
export const repoCommits = pgTable(
  "repo_commits",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    parentSha: text("parent_sha"),
    /** First 500 characters of the message. */
    message: text("message").notNull(),
    author: text("author").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    /** First 200 paths. */
    changedPaths: text("changed_paths").array().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("repo_commits_repo_sha_uq").on(t.repoId, t.sha),
    index().on(t.repoId, t.committedAt),
    index("repo_commits_paths_gin").using("gin", t.changedPaths),
    index().on(t.orgId),
  ],
);

// ---- gateway ----

export const modelCallStatus = pgEnum("model_call_status", ["ok", "error", "refused", "cache_hit"]);

/**
 * One row per logical model call through the gateway (R6.15): what ran, what it cost, and how it ended. Retries
 * of one call share a row (`attempts`). Correlation ids are nullable: indexing and CLI calls have no review run.
 */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id"),
    repoId: integer("repo_id"),
    reviewRunId: integer("review_run_id").references((): AnyPgColumn => reviewRuns.id, { onDelete: "set null" }),
    agentRunId: integer("agent_run_id"),
    task: text("task").notNull(),
    mode: text("mode"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Estimated USD; null when the model has no known price (never recorded as 0). */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    status: modelCallStatus("status").notNull(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.orgId, t.createdAt), index().on(t.reviewRunId)],
);

/**
 * Embeddings by content hash (R6.16). Content-addressed and deliberately shared across orgs: a row holds only the
 * vector a given model returns for a given text (never the text), so identical files in different orgs are embedded
 * once. Rows older than EMBEDDING_CACHE_TTL_DAYS are re-embedded and pruned. Vectors are zero-padded to
 * EMBEDDING_DIM; `dims` is the original width.
 */
export const embeddingCache = pgTable(
  "embedding_cache",
  {
    model: text("model").notNull(),
    contentHash: text("content_hash").notNull(),
    dims: integer("dims").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.model, t.contentHash] })],
);

/**
 * Opt-in cache of model responses (R6.16), keyed by a hash of everything that determines the answer (org, provider
 * and endpoint, model, task, effort, output limit, system, prompt, output schema). Responses can quote private
 * code, so entries are per org (`org_id`, null for calls without one) and purged with it. Expired rows are ignored
 * and pruned.
 */
export const llmResponseCache = pgTable(
  "llm_response_cache",
  {
    key: text("key").primaryKey(),
    orgId: text("org_id"),
    kind: text("kind").$type<"json" | "text">().notNull(),
    response: jsonb("response").$type<unknown>().notNull(),
    usage: jsonb("usage")
      .$type<{ inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }>()
      .notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.expiresAt), index().on(t.orgId)],
);

// ---- auth ----

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const inviteRole = pgEnum("invite_role", ["admin", "member"]);

/** A person who signs in (R6.1). Ids are `usr_` + a random token. */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Primary verified email from the identity provider, lowercased; null when the provider shares none. */
    email: text("email"),
    avatarUrl: text("avatar_url"),
    githubId: bigint("github_id", { mode: "number" }),
    githubLogin: text("github_login"),
    createdAt: createdAt(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_github_id_uq").on(t.githubId), index().on(t.email), index().on(t.githubLogin)],
);

/**
 * A linked identity: `github` today, `oidc` / `saml` later (`dev` for local development sign-in). The GitHub user
 * access token is stored encrypted (lib/crypto) and used only to verify which App installations the user can access.
 */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    login: text("login"),
    email: text("email"),
    accessTokenEnc: text("access_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("auth_accounts_provider_account_uq").on(t.provider, t.providerAccountId), index().on(t.userId)],
);

/** A signed-in browser. `id` is the SHA-256 of the cookie token; the raw token is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrgId: text("active_org_id").references(() => orgs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index().on(t.userId), index().on(t.expiresAt)],
);

/** A user's role in an org (R6.1). */
export const memberships = pgTable(
  "memberships",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId), index().on(t.userId)],
);

/**
 * An invitation to join an org, optionally restricted to one email or GitHub login (stored lowercased). Only the
 * SHA-256 of the link token is stored. Pending = not accepted, not revoked, and not expired (7 days).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: text("email"),
    githubLogin: text("github_login"),
    role: inviteRole("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("invitations_token_hash_uq").on(t.tokenHash),
    index().on(t.orgId),
    index().on(t.email),
    index().on(t.githubLogin),
    check("invitations_target_lowercase", sql`${t.email} = lower(${t.email}) AND ${t.githubLogin} = lower(${t.githubLogin})`),
  ],
);

// ---- pipeline ----

export const pullRequestState = pgEnum("pull_request_state", ["open", "closed", "merged"]);

/** A pull request as last ingested by a review run (R6.6). */
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    author: text("author").notNull().default(""),
    state: pullRequestState("state").notNull().default("open"),
    draft: boolean("draft").notNull().default(false),
    baseRef: text("base_ref").notNull(),
    headRef: text("head_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    url: text("url"),
    /** Head commit of the last completed review; incremental re-reviews start from here (R1.6). */
    lastReviewedSha: text("last_reviewed_sha"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("pull_requests_repo_number_uq").on(t.repoId, t.number), index().on(t.orgId)],
);

export const pullRequestCommits = pgTable(
  "pull_request_commits",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    pullRequestId: integer("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    message: text("message").notNull().default(""),
    author: text("author").notNull().default(""),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("pull_request_commits_pr_sha_uq").on(t.pullRequestId, t.sha), index().on(t.orgId)],
);

export const reviewRunStatus = pgEnum("review_run_status", [
  "queued",
  "ingesting",
  "retrieving_context",
  "reviewing",
  "verifying",
  "summarizing",
  "publishing",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "skipped",
]);

export const reviewRunTrigger = pgEnum("review_run_trigger", [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "manual",
  "mention",
  "api",
  "cli",
  "recovery",
]);

/** When a run entered a state and how long it stayed (set on leaving it). */
export interface StageTiming {
  startedAt: string;
  durationMs?: number;
}

/**
 * One review attempt of a pull request (R6.6): its state machine position, timings, what the engine saw and
 * decided, and what it cost. A PR's `reviews` row aggregates its runs.
 */
export const reviewRuns = pgTable(
  "review_runs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    reviewId: integer("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    /** Head commit under review; null until the run starts when the request did not name one. */
    headSha: text("head_sha"),
    baseSha: text("base_sha"),
    /** Incremental re-review: the previously reviewed head (R1.6). */
    sinceSha: text("since_sha"),
    trigger: reviewRunTrigger("trigger").notNull(),
    mode: text("mode"),
    focus: text("focus"),
    /** A manual "full" re-review ignores the incremental baseline. */
    full: boolean("full").notNull().default(false),
    requestedBy: text("requested_by"),
    status: reviewRunStatus("status").notNull().default("queued"),
    statusReason: text("status_reason"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    /** Times the run was started; recovery gives up after 3. */
    attempts: integer("attempts").notNull().default(0),
    jobId: text("job_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    stageTimings: jsonb("stage_timings").$type<Record<string, StageTiming>>().notNull().default({}),
    classification: jsonb("classification"),
    contextStats: jsonb("context_stats"),
    summary: jsonb("summary"),
    models: jsonb("models").$type<Record<string, string>>(),
    filesReviewed: integer("files_reviewed").notNull().default(0),
    findingsPublished: integer("findings_published").notNull().default(0),
    findingsRejected: integer("findings_rejected").notNull().default(0),
    findingsResolved: integer("findings_resolved").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Estimated USD; null when no call had a known price. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    credits: integer("credits").notNull().default(0),
    error: text("error"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.queuedAt), index().on(t.reviewId), index().on(t.status)],
);

/** One specialized agent's work within a run (R6.7), as reported by the engine. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    reviewRunId: integer("review_run_id")
      .notNull()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    status: text("status").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    latencyMs: integer("latency_ms").notNull().default(0),
    candidates: integer("candidates").notNull().default(0),
    accepted: integer("accepted").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.reviewRunId), index().on(t.orgId)],
);

export const findingVisibility = pgEnum("finding_visibility", ["published", "suppressed", "rejected"]);
export const findingStatus = pgEnum("finding_status", ["open", "resolved", "dismissed", "wont_fix", "false_positive"]);
export const findingResolution = pgEnum("finding_resolution", ["fixed", "user", "outdated"]);

/**
 * Structured findings (S10, R6.9), one row per (PR review, fingerprint), tracked across commits. Candidates the
 * engine rejected, and accepted findings held back (e.g. over the comment cap), are kept with their visibility and
 * verification reasons so the dashboard can explain why they were not posted.
 */
export const findings = pgTable(
  "findings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    reviewId: integer("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    firstRunId: integer("first_run_id").references(() => reviewRuns.id, { onDelete: "set null" }),
    lastRunId: integer("last_run_id").references(() => reviewRuns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    impact: text("impact").notNull().default(""),
    severity: text("severity").notNull(),
    /** 0..1 */
    confidence: real("confidence").notNull(),
    category: text("category").notNull(),
    /** Agent that raised it first. */
    agent: text("agent").notNull(),
    agents: text("agents").array().notNull().default([]),
    path: text("path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    symbol: text("symbol"),
    anchorCode: text("anchor_code").notNull().default(""),
    /** Head commit where the finding was last seen. */
    commitSha: text("commit_sha").notNull(),
    firstSeenSha: text("first_seen_sha").notNull(),
    evidence: jsonb("evidence")
      .$type<{ path: string; startLine: number; endLine: number; snippet: string; note: string }[]>()
      .notNull()
      .default([]),
    suggestedFix: text("suggested_fix").notNull().default(""),
    suggestion: text("suggestion"),
    ruleId: text("rule_id"),
    ruleText: text("rule_text"),
    verification: jsonb("verification"),
    visibility: findingVisibility("visibility").notNull(),
    status: findingStatus("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedSha: text("resolved_sha"),
    resolution: findingResolution("resolution"),
    fingerprint: text("fingerprint").notNull(),
    /** The inline comment that published it. */
    externalCommentId: bigint("external_comment_id", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("findings_review_fp_uq").on(t.reviewId, t.fingerprint),
    index().on(t.orgId, t.status, t.severity),
    index().on(t.repoId, t.createdAt),
    // Dashboard findings list: newest first within an org (R6.13).
    index().on(t.orgId, t.createdAt),
  ],
);

export const usageKind = pgEnum("usage_kind", ["review", "index", "chat", "knowledge", "embedding", "eval"]);

/** Metered usage (R6.16): one row per billable unit of work, e.g. one review run. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id"),
    reviewRunId: integer("review_run_id"),
    prNumber: integer("pr_number"),
    /** Pull request author, for active-developer billing. */
    author: text("author"),
    kind: usageKind("kind").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Estimated USD; null when unpriced. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    credits: integer("credits").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);

// ---- feedback ----

export const findingFeedbackSource = pgEnum("finding_feedback_source", [
  "dashboard",
  "api",
  "mcp",
  "cli",
  "github_reaction",
  "github_reply",
  "github_command",
]);
export const findingFeedbackKind = pgEnum("finding_feedback_kind", ["useful", "not_useful", "resolved", "wont_fix", "false_positive"]);

/**
 * Feedback on a finding (R6.10) from the dashboard, the API, MCP, the CLI, or GitHub (reactions, replies, and
 * commands on the finding's inline comment). Signed-in users are `userId`; GitHub authors are `externalAuthor` with
 * the reaction or comment id in `externalId`. A user's useful / not-useful vote replaces their previous one.
 */
export const findingFeedback = pgTable(
  "finding_feedback",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    findingId: integer("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    externalAuthor: text("external_author"),
    source: findingFeedbackSource("source").notNull(),
    kind: findingFeedbackKind("kind").notNull(),
    note: text("note"),
    externalId: bigint("external_id", { mode: "number" }),
    /** The learned preference this feedback was folded into, if any. */
    patternId: integer("pattern_id").references(() => learnedPatterns.id, { onDelete: "set null" }),
    /** False once a preference reset discarded what was learned from it; it still counts in feedback summaries. */
    countsForLearning: boolean("counts_for_learning").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("finding_feedback_external_uq").on(t.findingId, t.source, t.externalId).where(sql`${t.externalId} is not null`),
    uniqueIndex("finding_feedback_user_uq").on(t.findingId, t.userId, t.kind).where(sql`${t.userId} is not null`),
    index().on(t.orgId, t.createdAt),
    index().on(t.findingId),
  ],
);

// ---- conversations ----

export const conversationKind = pgEnum("conversation_kind", ["issue_comment", "review_comment", "review"]);
export const conversationRole = pgEnum("conversation_role", ["user", "assistant"]);

/**
 * A follow-up conversation with OpenReview on a pull request (R6.17): an inline review thread (keyed by its root
 * comment id), or the PR conversation (keyed by the PR number) for issue comments and review bodies.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    /** The OpenReview finding the thread is about (review threads on a finding's inline comment). */
    findingId: integer("finding_id").references(() => findings.id, { onDelete: "set null" }),
    kind: conversationKind("kind").notNull(),
    externalThreadId: bigint("external_thread_id", { mode: "number" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("conversations_thread_uq").on(t.repoId, t.kind, t.externalThreadId), index().on(t.orgId, t.repoId, t.prNumber)],
);

/** One message in a conversation: a person's mention (`user`) or OpenReview's reply (`assistant`). */
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: conversationRole("role").notNull(),
    author: text("author").notNull(),
    body: text("body").notNull(),
    externalCommentId: bigint("external_comment_id", { mode: "number" }),
    /** Detected intent of a user message (R6.17); the intent answered for an assistant message. */
    intent: text("intent"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conversation_messages_external_uq").on(t.conversationId, t.role, t.externalCommentId).where(sql`${t.externalCommentId} is not null`),
    index().on(t.conversationId, t.createdAt),
    index().on(t.orgId),
  ],
);
