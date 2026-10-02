import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
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

export interface RepoSettings {
  strictness?: "low" | "medium" | "high";
  commentTypes?: ("logic" | "security" | "style")[];
  ignore?: string[];
  context?: string[];
}

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** A Clerk organization. Every tenant-owned row references this id. */
export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

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
    suspended: boolean("suspended").notNull().default(false),
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

/** Webhook delivery ids already accepted; makes redelivery idempotent (R1.2). */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  action: text("action"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

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

export const reviewStatus = pgEnum("review_status", ["queued", "running", "completed", "failed", "skipped"]);

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("reviews_repo_pr_uq").on(t.repoId, t.prNumber), index().on(t.orgId, t.createdAt)],
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
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    replyCommentId: bigint("reply_comment_id", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mention_replies_source_uq").on(t.repoId, t.sourceCommentId)],
);

export const ruleStatus = pgEnum("rule_status", ["active", "candidate", "rejected"]);

/**
 * Plain-English review rules (R2.1), org-wide (`repoId` null) or per repo, optionally
 * limited to glob `paths`. Mined candidates (R2.5) start as `candidate` until approved.
 */
export const rules = pgTable(
  "rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").references(() => repos.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
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

/**
 * Conventions inferred from feedback on OpenReview comments (R2.4). `suppress`
 * patterns stop recurring; `boost` patterns are prioritized. Users can edit the
 * description and signal (`userEdited` pins the signal) or delete a pattern.
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId, t.repoId)],
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
