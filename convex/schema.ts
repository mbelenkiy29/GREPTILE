import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {repositoryContextValidator} from "./repositoryContextTypes";

const org = v.id("organizations"),
  repo = v.id("repositories"),
  review = v.id("reviews");
export const codingAgentValidator=v.union(v.literal("codex"),v.literal("claude"),v.literal("cursor"));
export const providerGroupValidator=v.object({externalId:v.string(),name:v.string()});
export const nativeDepotIndexValidator=v.object({requestedBy:v.id("users"),connectionId:v.id("providerConnections"),credentialDigest:v.string()});
export const p4PollingReference=v.object({id:v.id("p4Polls"),generation:v.number()});
export const runtimeEvidenceValidator = v.object({
  headSha: v.string(),
  image: v.string(),
  command: v.string(),
  exitCode: v.union(v.number(), v.null()),
  timedOut: v.boolean(),
  executionStarted:v.optional(v.boolean()),
  output: v.string(),
  outputTruncated: v.boolean(),
  network: v.literal("none"),
  memoryMb: v.literal(512),
  cpus: v.literal(1),
});
export const settingsValidator = v.object({
  automatic: v.boolean(),
  drafts: v.boolean(),
  targetBranches: v.array(v.string()),
  ignoredBranches: v.array(v.string()),
  ignoredPaths: v.array(v.string()),
  maxComments: v.number(),
  minimumConfidence: v.number(),
  severityThreshold: v.string(),
  categories: v.array(v.string()),
  model: v.string(),
  instructions: v.string(),
  rereview: v.boolean(),
  mode: v.string(),
  commentStyle: v.string(),
  summarySections:v.optional(v.array(v.string())),
  reviewEngine:v.optional(v.string()),
  checkFailureSeverity:v.optional(v.string()),
  triggerLabels:v.optional(v.array(v.string())),
  excludedAuthors:v.optional(v.array(v.string())),
  maxFiles:v.optional(v.number()),
  maxChangedLines:v.optional(v.number()),
  strictness:v.optional(v.number()),
  lockedKeys:v.optional(v.array(v.string())),
  autoApproveConventions:v.optional(v.boolean()),
  fixPullRequests:v.optional(v.boolean()),
  threadReplies:v.optional(v.boolean()),
  securityScan:v.optional(v.boolean()),
  aiAuthoredModel:v.optional(v.string()),
  maxReviewTier:v.optional(v.string()),
  agentTurns:v.optional(v.number()),
  agentToolCalls:v.optional(v.number()),
  hypothesisTurns:v.optional(v.number()),
  hypothesisToolCalls:v.optional(v.number()),
});
export const runtimePolicyValidator=v.object({enabled:v.boolean(),image:v.string(),command:v.string(),timeout:v.number(),requiredForApproval:v.boolean(),generatedTests:v.optional(v.boolean()),testCommand:v.optional(v.string())});
export const approvalPolicyValidator=v.object({enabled:v.boolean(),maximumRisk:v.union(v.literal("low"),v.literal("medium"),v.literal("high")),excludedPaths:v.array(v.string()),excludedAuthors:v.array(v.string()),requiredChecks:v.array(v.object({name:v.string(),appId:v.optional(v.number())}))});
export const findingValidator = v.object({
    title: v.string(),
    description: v.string(),
    severity: v.string(),
    confidence: v.number(),
    category: v.string(),
    filePath: v.string(),
    startLine: v.number(),
    endLine: v.number(),
    commitSha: v.string(),
    evidence: v.array(
      v.object({
        filePath: v.string(),
        startLine: v.number(),
        quote: v.string(),
        repository: v.optional(v.string()),
        revision: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
      }),
    ),
    impact: v.string(),
    suggestedFix: v.string(),
    agent: v.string(),
    symbol: v.string(),
    ruleId: v.optional(v.string()),
    suggestion: v.optional(v.object({ startLine: v.number(), endLine: v.number(), original: v.string(), replacement: v.string() })),
    fingerprint: v.string(),
    // Anchored on an unchanged line the change breaks; published in the summary only.
    outsideDiff: v.optional(v.boolean()),
    question: v.optional(v.string()),
    generatedTest: v.optional(v.object({ path: v.string(), command: v.string(), code: v.string(), status: v.string(), exitCode: v.optional(v.union(v.number(), v.null())), timedOut: v.boolean(), executionStarted: v.boolean(), output: v.string() })),
});
export default defineSchema({
  inferenceBudgets: defineTable({limitMicros:v.number(),baselineMicros:v.number(),source:v.string(),committedMicros:v.number(),reservedMicros:v.number(),createdAt:v.number()}),
  inferenceReservations: defineTable({budgetId:v.id("inferenceBudgets"),provider:v.string(),model:v.string(),baseUrl:v.string(),inputTokenCeiling:v.number(),outputTokenCeiling:v.number(),inputPrice:v.number(),outputPrice:v.number(),cacheReadPrice:v.optional(v.number()),cacheWritePrice:v.optional(v.number()),reservedMicros:v.number(),status:v.string(),createdAt:v.number(),inputTokens:v.optional(v.number()),outputTokens:v.optional(v.number()),cacheReadTokens:v.optional(v.number()),cacheWriteTokens:v.optional(v.number()),settledMicros:v.optional(v.number()),settledAt:v.optional(v.number())}).index("by_budget",["budgetId"]),
  reviewFindings: defineTable({reviewId:review,findingId:v.id("findings"),snapshot:findingValidator}).index("by_review",["reviewId"]),
  integrationConnections:defineTable({organizationId:org,kind:v.union(v.literal("linear"),v.literal("atlassian"),v.literal("notion")),sites:v.optional(v.array(v.object({id:v.string(),name:v.string(),url:v.string(),scopes:v.array(v.string())}))),jiraProjectIds:v.optional(v.array(v.string())),confluenceSpaceIds:v.optional(v.array(v.string())),externalId:v.string(),name:v.string(),credentials:v.string(),expiresAt:v.number(),active:v.boolean(),generation:v.number(),teamIds:v.array(v.string()),projectIds:v.array(v.string()),repositoryIds:v.array(repo),refreshLease:v.optional(v.string()),refreshExpiresAt:v.optional(v.number()),error:v.optional(v.string()),createdAt:v.number()}).index("by_org",["organizationId"]).index("by_account",["organizationId","kind","externalId"]),
  integrationRevocations:defineTable({connectionId:v.id("integrationConnections"),organizationId:org,credentials:v.string(),attempts:v.number(),createdAt:v.number(),status:v.string(),lease:v.optional(v.string()),leaseExpiresAt:v.optional(v.number())}).index("by_connection",["connectionId"]),
  approvalPolicies:defineTable({organizationId:org,teamId:v.optional(v.id("teams")),repositoryId:v.optional(repo),policy:approvalPolicyValidator,updatedAt:v.number()}).index("by_org",["organizationId"]),
  approvalJobs:defineTable({organizationId:org,repositoryId:repo,reviewId:review,prNumber:v.number(),headSha:v.string(),policyKey:v.string(),status:v.string(),reasons:v.array(v.string()),providerReviewId:v.optional(v.union(v.number(),v.string())),lease:v.optional(v.string()),leaseExpiresAt:v.optional(v.number()),createdAt:v.number(),updatedAt:v.number()}).index("by_review",["reviewId"]).index("by_repo_pr",["repositoryId","prNumber"]).index("by_status",["status"]).index("by_org_status",["organizationId","status"]),
  runtimePolicies:defineTable({organizationId:org,teamId:v.optional(v.id("teams")),repositoryId:v.optional(repo),policy:runtimePolicyValidator,updatedAt:v.number()}).index("by_org",["organizationId"]),
  runtimeWorkers:defineTable({organizationId:org,tokenHash:v.string(),name:v.string(),expiresAt:v.number(),revoked:v.boolean(),lastSeen:v.optional(v.number()),createdAt:v.number()}).index("by_hash",["tokenHash"]).index("by_org",["organizationId"]),
  runtimeJobs:defineTable({organizationId:org,repositoryId:repo,reviewId:review,headSha:v.string(),revisionKey:v.optional(v.string()),policy:runtimePolicyValidator,policyKey:v.string(),status:v.string(),error:v.optional(v.string()),sourceStorageId:v.optional(v.id("_storage")),workerId:v.optional(v.id("runtimeWorkers")),lease:v.optional(v.string()),leaseExpiresAt:v.optional(v.number()),attempts:v.number(),evidence:v.optional(runtimeEvidenceValidator),
    // Generated reproduction tests (kind "tests"): never committed; results attach to their findings.
    kind:v.optional(v.literal("tests")),tests:v.optional(v.array(v.object({fingerprint:v.string(),path:v.string(),content:v.string(),command:v.string()}))),testResults:v.optional(v.array(v.object({fingerprint:v.string(),evidence:v.optional(runtimeEvidenceValidator),error:v.optional(v.string())}))),
    createdAt:v.number(),updatedAt:v.number()}).index("by_review",["reviewId"]).index("by_org_status",["organizationId","status"]).index("by_status",["status"]),
  providerConnections: defineTable({organizationId:org,kind:v.string(),instance:v.string(),name:v.string(),credentials:v.string(),webhookSecret:v.string(),installationId:v.optional(v.string()),namespaceId:v.optional(v.string()),forgeEventAt:v.optional(v.number()),forgeRefreshAt:v.optional(v.number()),suspended:v.optional(v.boolean()),active:v.boolean(),createdAt:v.number(),lastEventAt:v.optional(v.number()),error:v.optional(v.string())}).index("by_org",["organizationId"]).index("by_installation",["kind","installationId"]),
  providerReceipts: defineTable({jti:v.string(),expiresAt:v.number()}).index("by_jti",["jti"]),
  providerInstallRequests:defineTable({organizationId:org,userId:v.id("users"),tokenHash:v.string(),expiresAt:v.number(),consumed:v.boolean(),createdAt:v.number()}).index("by_hash",["tokenHash"]),
  providerIdentityGrants:defineTable({repositoryId:repo,connectionId:v.id("providerConnections"),userId:v.id("users"),digest:v.string(),tokenHash:v.string(),expiresAt:v.number(),consumed:v.boolean()}).index("by_hash",["tokenHash"]),
  providerIdentities:defineTable({organizationId:org,connectionId:v.id("providerConnections"),userId:v.id("users"),externalId:v.string(),username:v.string(),credentials:v.optional(v.string()),connectionDigest:v.string(),active:v.boolean(),generation:v.number(),expiresAt:v.number(),createdAt:v.number(),updatedAt:v.number()}).index("by_connection_user",["connectionId","userId"]).index("by_connection_external",["connectionId","externalId"]),
  p4Identities:defineTable({organizationId:org,repositoryId:repo,connectionId:v.id("providerConnections"),userId:v.id("users"),username:v.string(),credentials:v.optional(v.string()),connectionDigest:v.string(),active:v.boolean(),generation:v.number(),expiresAt:v.number(),createdAt:v.number(),updatedAt:v.number()}).index("by_repo_user",["repositoryId","userId"]).index("by_repo_username",["repositoryId","username"]).index("by_user",["userId"]),
  p4Polls:defineTable({organizationId:org,repositoryId:repo,requestedBy:v.id("users"),connectionId:v.id("providerConnections"),credentialDigest:v.string(),baselineJobId:v.id("indexJobs"),enabled:v.boolean(),generation:v.number(),status:v.string(),cursor:v.optional(v.number()),pending:v.array(v.number()),position:v.number(),pages:v.number(),scanned:v.number(),skipped:v.number(),diagnostics:v.array(v.object({nativeNumber:v.number(),reason:v.string()})),attempts:v.number(),error:v.optional(v.string()),scheduledId:v.optional(v.id("_scheduled_functions")),nextAt:v.optional(v.number()),lease:v.optional(v.object({id:v.string(),expiresAt:v.number()})),lastCompleteAt:v.optional(v.number()),updatedAt:v.number(),createdAt:v.number()}).index("by_repo",["repositoryId"]).index("by_org",["organizationId"]).index("by_enabled",["enabled"]),
  providerEvents: defineTable({connectionId:v.id("providerConnections"),externalId:v.string(),body:v.string(),eventType:v.optional(v.string()),status:v.string(),error:v.optional(v.string()),createdAt:v.number(),updatedAt:v.optional(v.number()),attempts:v.number()}).index("by_delivery",["connectionId","externalId"]).index("by_connection_created",["connectionId","createdAt"]).index("by_status",["status"]),
  teams: defineTable({ organizationId: org, name: v.string(), externalKey: v.optional(v.string()), createdAt: v.number() }).index("by_org", ["organizationId"]),
  teamMembers: defineTable({ organizationId: org, teamId: v.id("teams"), userId: v.id("users"), role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")) }).index("by_team", ["teamId"]).index("by_team_user", ["teamId", "userId"]),
  scopeSettings: defineTable({ organizationId: org, teamId: v.optional(v.id("teams")), settings: settingsValidator, overrideKeys: v.array(v.string()) }).index("by_org", ["organizationId"]).index("by_team", ["teamId"]),
  repositoryClusters: defineTable({ organizationId: org, name: v.string(), repositoryIds: v.array(repo), createdAt: v.number() }).index("by_org", ["organizationId"]),
  auditEvents: defineTable({ organizationId: org, userId: v.optional(v.id("users")), action: v.string(), target: v.string(), createdAt: v.number() }).index("by_org", ["organizationId"]),
  personalSettings: defineTable({ userId: v.id("users"), agent: v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor")), updatedAt: v.number() }).index("by_user", ["userId"]),
  bridgeDevices: defineTable({ tokenHash: v.string(), code: v.string(), userId: v.optional(v.id("users")), organizationId: v.optional(org), name: v.string(), expiresAt: v.number(), revoked: v.boolean(), createdAt: v.number(), lastSeen: v.optional(v.number()) }).index("by_hash", ["tokenHash"]).index("by_code", ["code"]).index("by_user", ["userId"]),
  fixRequests: defineTable({ userId: v.id("users"), organizationId: org, repositoryId: repo, reviewId: review, headSha: v.string(), findingIds: v.optional(v.array(v.id("findings"))), agent: v.string(), prompt: v.string(), status: v.string(), error: v.optional(v.string()), deviceId: v.optional(v.id("bridgeDevices")), expiresAt: v.number(), createdAt: v.number(), updatedAt: v.number() }).index("by_user", ["userId"]).index("by_review", ["reviewId"]),
  rateLimits: defineTable({
    key: v.string(),
    window: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),
  modelCache: defineTable({
    organizationId: org,
    key: v.string(),
    result: v.string(),
    expiresAt: v.number(),
  })
    .index("by_key", ["organizationId", "key"])
    .index("by_expiry", ["expiresAt"]),
  codeChunks: defineTable({
    organizationId: org,
    repositoryId: repo,
    filePath: v.string(),
    startLine: v.number(),
    content: v.string(),
  })
    .index("by_file", ["repositoryId", "filePath"])
    .searchIndex("by_content", {
      searchField: "content",
      filterFields: ["repositoryId", "organizationId"],
    }),
  embeddings: defineTable({
    organizationId: org,
    repositoryId: repo,
    path: v.string(),
    sha: v.string(),
    model: v.string(),
    scope: v.string(),
    vector: v.array(v.float64()),
    updatedAt: v.number(),
  })
    .index("by_path", ["repositoryId", "path"])
    .vectorIndex("by_vector", {
      vectorField: "vector",
      dimensions: 1536,
      filterFields: ["scope"],
    }),
  // Chunk-level embeddings (definition-boundary chunks). The file-level `embeddings` table above
  // is legacy: no longer written, rows are removed as their files are re-indexed or deleted.
  chunkEmbeddings: defineTable({
    organizationId: org,
    repositoryId: repo,
    path: v.string(),
    sha: v.string(),
    model: v.string(),
    scope: v.string(),
    startLine: v.number(),
    endLine: v.number(),
    symbol: v.optional(v.string()),
    vector: v.array(v.float64()),
    updatedAt: v.number(),
  })
    .index("by_path", ["repositoryId", "path"])
    .vectorIndex("by_vector", {
      vectorField: "vector",
      dimensions: 1536,
      filterFields: ["scope"],
    }),
  users: defineTable({
    // Legacy GitHub identity; new accounts link providers through `identities`.
    githubId: v.optional(v.number()),
    login: v.string(),
    avatar: v.string(),
    // Tokens issued before this time are rejected ("sign out everywhere", member removal).
    sessionsValidAfter: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_github", ["githubId"]),
  // Sign-in identities: one row per provider account. Accounts link only through a verified
  // email on both sides, so an unverified address can never take over an existing user.
  identities: defineTable({
    userId: v.id("users"),
    provider: v.string(), // github | gitlab | google | email
    providerUserId: v.string(),
    email: v.optional(v.string()),
    emailVerified: v.boolean(),
    createdAt: v.number(),
    lastLoginAt: v.number(),
  }).index("by_provider_user", ["provider", "providerUserId"]).index("by_user", ["userId"]).index("by_email", ["email"]),
  // Server-side browser sessions; the session cookie carries a random ID whose SHA-256 is stored.
  sessions: defineTable({
    userId: v.id("users"),
    hash: v.string(),
    provider: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  }).index("by_hash", ["hash"]).index("by_user", ["userId"]),
  // Email invitations and magic links: single-use, expiring, stored as token hashes only.
  emailInvitations: defineTable({
    organizationId: org,
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")),
    tokenHash: v.string(),
    invitedBy: v.id("users"),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedBy: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_token", ["tokenHash"]).index("by_org", ["organizationId"]),
  loginTokens: defineTable({ email: v.string(), tokenHash: v.string(), expiresAt: v.number(), usedAt: v.optional(v.number()), createdAt: v.number() }).index("by_token", ["tokenHash"]),
  organizations: defineTable({ name: v.string(), defaultAgent:v.optional(codingAgentValidator), onboardingRepositoryIds:v.optional(v.array(repo)), analyticsMinutesPerFinding:v.optional(v.number()), createdAt: v.number() }),
  // Daily analytics rollup per (repository, UTC day, PR author), recomputed from raw tables for
  // recent days by a cron; dashboards read only these rows.
  analyticsDaily: defineTable({
    organizationId: org,
    repositoryId: repo,
    day: v.string(),
    author: v.string(),
    reviews: v.number(),
    completed: v.number(),
    findings: v.number(),
    high: v.number(),
    addressed: v.number(),
    useful: v.number(),
    notUseful: v.number(),
    // Outcome signals recorded that day: fixed by a follow-up commit / merged with the finding open.
    commitAddressed: v.optional(v.number()),
    ignored: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_org_day", ["organizationId", "day"]),
  organizationMembers: defineTable({
    organizationId: org,
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer")),
  })
    .index("by_org", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_org_user", ["organizationId", "userId"]),
  invitations: defineTable({
    organizationId: org,
    githubLogin: v.string(),
    role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")),
    expiresAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_login", ["githubLogin"]),
  githubInstallations: defineTable({
    organizationId: org,
    installationId: v.number(),
    account: v.string(),
    accountId: v.number(),
    active: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_installation", ["installationId"])
    .index("by_org", ["organizationId"]),
  repositories: defineTable({
    indexScheduledId:v.optional(v.id("_scheduled_functions")),
    // Incremental ingestion of human review comments for learned conventions.
    conventionsCursor: v.optional(v.number()),
    conventionsSyncedAt: v.optional(v.number()),
    // Latest repository config file read from a pull request base revision (for the dashboard).
    configFile: v.optional(v.object({ sha: v.string(), files: v.array(v.string()), applied: v.array(v.string()), blocked: v.array(v.string()), warnings: v.array(v.string()), values: v.string(), rules: v.number(), checkedAt: v.number(), cascade: v.optional(v.string()) })),
    branches: v.optional(
      v.array(
        v.object({ name: v.string(), sha: v.string(), protected: v.boolean() }),
      ),
    ),
    branchesLimited: v.optional(v.boolean()),
    organizationId: org,
    teamId: v.optional(v.id("teams")),
    installationId: v.optional(v.number()),
    githubId: v.optional(v.number()),
    connectionId: v.optional(v.id("providerConnections")),
    externalId: v.optional(v.string()),
    remoteUrl: v.optional(v.string()),
    fullName: v.string(),
    defaultBranch: v.string(),
    enabled: v.boolean(),
    indexStatus: v.string(),
    indexedSha: v.optional(v.string()),
    pendingIndexSha: v.optional(v.string()),
    knowledgeStatus: v.optional(v.string()),
    knowledgeError: v.optional(v.string()),
    knowledgePaths: v.optional(v.array(v.string())),
    knowledgeAttempt: v.optional(v.number()),
    knowledgeUpdatedAt: v.optional(v.number()),
    indexedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_connection", ["connectionId", "externalId"])
    .index("by_github", ["githubId"])
    .index("by_org", ["organizationId"])
    .index("by_installation", ["installationId"]),
  repositorySettings: defineTable({
    repositoryId: repo,
    organizationId: org,
    settings: settingsValidator,
    inherit: v.optional(v.boolean()),
  }).index("by_repo", ["repositoryId"]),
  repositoryFiles: defineTable({
    organizationId: org,
    repositoryId: repo,
    path: v.string(),
    sha: v.string(),
    storageId: v.id("_storage"),
    language: v.string(),
    graphVersion: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_repo", ["repositoryId"])
    .index("by_path", ["repositoryId", "path"]),
  graphModuleReferences: defineTable({
    repositoryId: repo,
    path: v.string(),
    sha: v.string(),
    graphVersion: v.number(),
    references: v.array(v.object({specifier:v.string(),resolvedPath:v.string()})),
  }).index("by_path", ["repositoryId", "path"]),
  symbols: defineTable({
    organizationId: org,
    repositoryId: repo,
    filePath: v.string(),
    name: v.string(),
    kind: v.string(),
    line: v.number(),
    exported: v.boolean(),
  })
    .index("by_repo", ["repositoryId"])
    .index("by_file", ["repositoryId", "filePath"])
    .index("by_name", ["repositoryId", "name"]),
  relationships: defineTable({
    organizationId: org,
    repositoryId: repo,
    from: v.string(),
    sourcePath: v.string(),
    to: v.string(),
    kind: v.string(),
    symbol: v.optional(v.string()),
    resolved: v.optional(v.boolean()),
  })
    .index("by_repo", ["repositoryId"])
    .index("by_source", ["repositoryId", "sourcePath"])
    .index("by_from", ["repositoryId", "from"])
    .index("by_to", ["repositoryId", "to"]),
  indexJobs: defineTable({
    organizationId: org,
    repositoryId: repo,
    sha: v.string(),
    nativeDepot:v.optional(nativeDepotIndexValidator),
    batchLease:v.optional(v.object({id:v.string(),expiresAt:v.number()})),
    manifestStorageId: v.optional(v.id("_storage")),
    skipped: v.optional(v.array(v.object({path:v.string(),reason:v.string()}))),
    skippedTotal: v.optional(v.number()),
    cursor: v.optional(v.number()),
    status: v.string(),
    total: v.number(),
    processed: v.number(),
    changed: v.number(),
    attempts: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repo", ["repositoryId"])
    .index("by_status", ["status"]),
  indexSkippedFiles: defineTable({
    jobId: v.id("indexJobs"),
    path: v.string(),
  }).index("by_job_path", ["jobId", "path"]),
  knowledgeEntries: defineTable({
    organizationId: org,
    repositoryId: repo,
    subsystem: v.string(),
    description: v.string(),
    files: v.array(v.string()),
    dependencies: v.array(v.string()),
    risks: v.array(v.string()),
    conventions: v.array(v.string()),
    sha: v.string(),
    updatedAt: v.number(),
  })
    .index("by_repo", ["repositoryId"])
    .index("by_subsystem", ["repositoryId", "subsystem"]),
  pullCatalogJobs: defineTable({
    organizationId:org,repositoryId:repo,authority:v.string(),status:v.string(),cursor:v.union(v.string(),v.null()),seenCursors:v.array(v.string()),
    processed:v.number(),pages:v.number(),attempts:v.number(),error:v.optional(v.string()),
    scheduledId:v.optional(v.id("_scheduled_functions")),lease:v.optional(v.object({id:v.string(),expiresAt:v.number()})),createdAt:v.number(),updatedAt:v.number(),
  }).index("by_repo",["repositoryId"]).index("by_status",["status"]),
  pullRequests: defineTable({
    reactionsSyncedAt: v.optional(v.number()),
    organizationId: org,
    repositoryId: repo,
    number: v.number(),
    title: v.string(),
    author: v.string(),
    url: v.string(),
    headSha: v.string(),
    baseSha: v.string(),
    state: v.string(),
    updatedAt: v.number(),
    nativeObservedAt: v.optional(v.number()),
    revisionKey: v.optional(v.string()),
  })
    .index("by_repo_number", ["repositoryId", "number"])
    .index("by_org", ["organizationId"])
    .searchIndex("by_title",{searchField:"title",filterFields:["organizationId"]}),
  pullRequestCommits: defineTable({
    organizationId: org,
    pullRequestId: v.id("pullRequests"),
    sha: v.string(),
  }).index("by_pr", ["pullRequestId"]),
  reviews: defineTable({
    reviewScore: v.optional(v.object({value:v.number(),reason:v.string()})),
    verdict: v.optional(v.union(v.literal("ready"),v.literal("fixes"),v.literal("changes"),v.literal("incomplete"))),
    requirementsNotMet: v.optional(v.number()),
    // K2: a tier asked for by an @openreview command or an openreview:<tier> label, and the tier used.
    requestedMode: v.optional(v.union(v.literal("fast"),v.literal("standard"),v.literal("deep"))),
    requestedModeSource: v.optional(v.union(v.literal("comment"), v.literal("label"))),
    modeDecision: v.optional(v.object({ mode: v.string(), source: v.string(), capped: v.boolean(), requested: v.string() })),
    aiAuthored: v.optional(v.object({ agent: v.string(), kind: v.string(), detail: v.string(), model: v.optional(v.string()) })),
    // Ordinal among this pull request's published reviews, fixed at first publication.
    reviewNumber: v.optional(v.number()),
    approvalAssessment: v.optional(v.object({risk:v.union(v.literal("low"),v.literal("medium"),v.literal("high"),v.literal("unknown")),confidence:v.number(),reason:v.string()})),
    coverageLimits: v.optional(v.array(v.string())),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    headBranch: v.optional(v.string()),
    baseBranch: v.optional(v.string()),
    findingCount: v.optional(v.number()),
    findingSeverity: v.optional(v.string()),
    models: v.optional(v.string()),
    runtimeEvidence: v.optional(runtimeEvidenceValidator),
    organizationId: org,
    repositoryId: repo,
    prNumber: v.number(),
    headSha: v.string(),
    revisionKey: v.optional(v.string()),
    baseSha: v.optional(v.string()),
    status: v.string(),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    mode: v.string(),
    category: v.optional(v.string()),
    attempts: v.number(),
    githubReviewId: v.optional(v.union(v.number(),v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
    resultStorageId: v.optional(v.id("_storage")),
    // Agentic tool-loop transcript/state, kept between execution steps and deleted when the review ends.
    agentStateStorageId: v.optional(v.id("_storage")),
    agentStateHead: v.optional(v.string()),
    // GitHub check run created for this review's head (checks:write only).
    checkRunId: v.optional(v.number()),
    trigger: v.optional(v.string()),
    checkRunHead: v.optional(v.string()),
    repositoryContext:v.optional(repositoryContextValidator),
    nativeP4: v.optional(v.object({requestedBy:v.id("users"),connectionId:v.id("providerConnections"),credentialDigest:v.string(),baselineJobId:v.id("indexJobs"),inputStorageId:v.id("_storage"),polling:v.optional(p4PollingReference),lease:v.optional(v.object({id:v.string(),expiresAt:v.number()}))})),
    retryScheduledId: v.optional(v.id("_scheduled_functions")),
    retryAt: v.optional(v.number()),
    findingsRecorded: v.optional(v.boolean()),
  })
    .index("by_org", ["organizationId"])
    .index("by_repo", ["repositoryId"])
    .index("by_head", ["repositoryId", "prNumber", "headSha"])
    .index("by_pr", ["repositoryId", "prNumber"])
    .index("by_status", ["status"])
    .index("by_org_time", ["organizationId", "createdAt"]),
  reviewRuns: defineTable({
    organizationId: org,
    reviewId: review,
    stage: v.string(),
    createdAt: v.number(),
    detail: v.string(),
  }).index("by_review", ["reviewId"]),
  agentRuns: defineTable({
    organizationId: org,
    reviewId: review,
    agent: v.string(),
    model: v.string(),
    durationMs: v.number(),
    tokens: v.number(),
  }).index("by_review", ["reviewId"]),
  findings: defineTable({
    organizationId: org,
    repositoryId: repo,
    reviewId: review,
    prNumber: v.number(),
    author: v.optional(v.string()),
    lastFeedback: v.optional(v.string()),
    ...findingValidator.fields,
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_review", ["reviewId"])
    .index("by_repo", ["repositoryId"])
    .index("by_repo_path", ["repositoryId", "filePath"])
    .index("by_pr", ["repositoryId", "prNumber"])
    .index("by_fingerprint", ["repositoryId", "prNumber", "fingerprint"])
    .index("by_org_time", ["organizationId", "createdAt"]),
  // Team conventions learned from human review comments (review guidance only).
  // Cloud billing (BILLING_ENABLED=true only). One account per workspace; Stripe state is applied
  // from signed webhooks, newest event wins.
  billingAccounts: defineTable({
    organizationId: org,
    customerId: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
    subscriptionItemId: v.optional(v.string()),
    status: v.string(), // trial | active | trialing | past_due | unpaid | canceled | incomplete | incomplete_expired | paused
    seats: v.number(),
    trialEndsAt: v.number(),
    currentPeriodEnd: v.optional(v.number()),
    pastDueSince: v.optional(v.number()),
    lastEventCreated: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_org", ["organizationId"]).index("by_customer", ["customerId"]),
  billingUsage: defineTable({ organizationId: org, period: v.string(), reviews: v.number(), blocked: v.number() }).index("by_org_period", ["organizationId", "period"]),
  stripeEvents: defineTable({ eventId: v.string(), type: v.string(), outcome: v.string(), createdAt: v.number() }).index("by_event", ["eventId"]),
  // Slack app installs (one per Slack workspace); the bot token is encrypted with scope `<org>:slack`.
  slackInstallations: defineTable({
    organizationId: org,
    teamId: v.string(),
    teamName: v.string(),
    botUserId: v.string(),
    credentials: v.string(),
    installedBy: v.id("users"),
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_team", ["teamId"]).index("by_org", ["organizationId"]),
  // Admin-linked Slack channels: notification events, and the repositories Q&A may read
  // (empty repositoryIds = notifications for every repository, Q&A disabled).
  notificationChannels: defineTable({
    organizationId: org,
    installationId: v.id("slackInstallations"),
    channelId: v.string(),
    repositoryIds: v.array(repo),
    events: v.array(v.string()),
    qa: v.boolean(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_org", ["organizationId"]).index("by_channel", ["installationId", "channelId"]),
  // Per-member email notifications ("off" | "mine" | "all"); sent only to a verified address.
  notificationPreferences: defineTable({
    organizationId: org,
    userId: v.id("users"),
    email: v.optional(v.string()),
    emailVerifiedAt: v.optional(v.number()),
    verificationHash: v.optional(v.string()),
    verificationExpiresAt: v.optional(v.number()),
    reviewCompleted: v.string(),
    highSeverity: v.string(),
    updatedAt: v.number(),
  }).index("by_user_org", ["userId", "organizationId"]).index("by_org", ["organizationId"]).index("by_verification", ["verificationHash"]),
  // One row per (event, review, target): retries never notify twice.
  notificationDeliveries: defineTable({
    organizationId: org,
    key: v.string(),
    channel: v.string(),
    status: v.string(), // sending | sent | skipped | failed
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  slackEventReceipts: defineTable({ eventId: v.string(), createdAt: v.number() }).index("by_event", ["eventId"]),
  // Codebase chat (web): threads are private to the member who started them.
  chatThreads: defineTable({
    organizationId: org,
    userId: v.id("users"),
    title: v.string(),
    repositoryIds: v.array(repo),
    origin: v.optional(v.string()), // web (default) | api
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org_user", ["organizationId", "userId", "updatedAt"]),
  // Assistant messages stream progress through `events` (persisted deltas read by the SSE route);
  // `content` and `citations` are written only after citation validation.
  chatMessages: defineTable({
    organizationId: org,
    threadId: v.id("chatThreads"),
    userId: v.id("users"),
    role: v.string(), // user | assistant
    content: v.string(),
    status: v.string(), // pending | running | completed | failed
    repositoryIds: v.array(repo),
    citations: v.optional(v.array(v.object({ repositoryId: repo, repository: v.string(), filePath: v.string(), startLine: v.number(), endLine: v.number(), quote: v.string(), revision: v.string(), url: v.optional(v.string()) }))),
    events: v.optional(v.array(v.object({ at: v.number(), kind: v.string(), text: v.string() }))),
    limits: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    estimatedCost: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_thread", ["threadId"]), // ordered by insertion (_creationTime)
  learnedRules: defineTable({
    organizationId: org,
    repositoryId: repo,
    text: v.string(),
    category: v.string(),
    status: v.string(), // suggested | approved | rejected | disabled
    scope: v.optional(v.string()), // repo (default) | team | workspace
    teamId: v.optional(v.id("teams")),
    frequency: v.number(),
    evidence: v.array(v.object({ url: v.string(), author: v.string(), excerpt: v.string() })),
    decidedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repo_status", ["repositoryId", "status"])
    .index("by_org", ["organizationId"])
    .index("by_org_scope", ["organizationId", "scope"]),
  // 👍/👎 reactions on OpenReview's own finding comments, mirrored from the provider
  // (GitHub: polled; GitLab: emoji webhooks). Bots never count.
  commentReactions: defineTable({
    organizationId: org,
    repositoryId: repo,
    prNumber: v.number(),
    provider: v.string(),
    commentId: v.string(),
    findingId: v.optional(v.id("findings")),
    user: v.string(),
    reaction: v.string(),
    createdAt: v.number(),
  })
    .index("by_comment", ["repositoryId", "commentId"])
    .index("by_finding", ["findingId"])
    .index("by_org_time", ["organizationId", "createdAt"]),
  findingFeedback: defineTable({
    organizationId: org,
    findingId: v.id("findings"),
    userId: v.optional(v.id("users")),
    githubLogin: v.optional(v.string()),
    value: v.string(),
    comment: v.string(),
    createdAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_finding", ["findingId"]),
  // Learning from commits: one outcome per finding. "addressed" = a later commit changed the flagged
  // lines and the fix was verified; "ignored" = merged while still open with no human feedback.
  findingSignals: defineTable({
    organizationId: org,
    repositoryId: repo,
    findingId: v.id("findings"),
    prNumber: v.number(),
    signal: v.string(), // addressed | ignored
    category: v.string(),
    severity: v.string(),
    author: v.optional(v.string()),
    commitSha: v.string(),
    createdAt: v.number(),
  })
    .index("by_finding", ["findingId"])
    .index("by_repo_category", ["repositoryId", "category", "createdAt"])
    .index("by_org_time", ["organizationId", "createdAt"]),
  learnedPreferences: defineTable({
    organizationId: org,
    repositoryId: repo,
    category: v.string(),
    instruction: v.string(),
    source: v.string(),
    findingId:v.optional(v.id("findings")),
    conversationId:v.optional(v.id("conversations")),
    feedbackId:v.optional(v.id("findingFeedback")),
    sourceReviewId:v.optional(review),
    updatedAt:v.optional(v.number()),
    // Scope beyond the source repository: "team" (its team) or "workspace" (every repository).
    scope:v.optional(v.string()),
    teamId:v.optional(v.id("teams")),
    enabled: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_repo", ["repositoryId"])
    .index("by_source", ["repositoryId", "source"])
    .index("by_org_scope", ["organizationId", "scope"]),
  customRules: defineTable({
    organizationId: org,
    // Scope (K4): none = workspace, repositoryId = one repository, teamId = the team's repositories,
    // repositoryPattern = repositories whose full name matches the glob.
    repositoryId: v.optional(repo),
    teamId: v.optional(v.id("teams")),
    repositoryPattern: v.optional(v.string()),
    title: v.string(),
    instructions: v.string(),
    category: v.string(),
    severity: v.string(),
    globs: v.array(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_repo", ["repositoryId"]),
  // AI rule assistant: admin-requested runs and the suggestions they produce. Nothing changes a rule
  // until an admin approves the suggestion.
  ruleAssistantRuns: defineTable({
    organizationId: org,
    kind: v.string(), // draft | refine | suggest
    status: v.string(), // pending | completed | failed
    description: v.optional(v.string()),
    repositoryId: v.optional(repo),
    teamId: v.optional(v.id("teams")),
    repositoryPattern: v.optional(v.string()),
    suggestions: v.optional(v.number()),
    rejected: v.optional(v.array(v.object({ title: v.string(), reason: v.string() }))),
    error: v.optional(v.string()),
    requestedBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org_time", ["organizationId", "createdAt"]),
  ruleSuggestions: defineTable({
    organizationId: org,
    runId: v.id("ruleAssistantRuns"),
    kind: v.string(), // draft | refine | suggest | flag
    status: v.string(), // suggested | approved | rejected | stale
    title: v.string(),
    instructions: v.string(),
    category: v.string(),
    severity: v.string(),
    globs: v.array(v.string()),
    repositoryId: v.optional(repo),
    teamId: v.optional(v.id("teams")),
    repositoryPattern: v.optional(v.string()),
    targetRuleId: v.optional(v.id("customRules")),
    base: v.optional(v.object({ title: v.string(), instructions: v.string() })),
    rationale: v.string(),
    issues: v.array(v.object({ kind: v.string(), detail: v.string(), ruleId: v.optional(v.string()) })),
    sources: v.array(v.object({ kind: v.string(), label: v.string(), ids: v.array(v.string()), detail: v.optional(v.string()) })),
    ruleId: v.optional(v.id("customRules")),
    decidedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_status", ["organizationId", "status"])
    .index("by_run", ["runId"]),
  // Feature tips shown in review footers (one per review); drives the per-repository cooldown.
  featureTips: defineTable({ organizationId: org, repositoryId: repo, reviewId: review, key: v.string(), ticket: v.optional(v.string()), shownAt: v.number() })
    .index("by_repo_time", ["repositoryId", "shownAt"])
    .index("by_review", ["reviewId"]),
  reviewComments: defineTable({
    organizationId: org,
    reviewId: review,
    githubId: v.union(v.number(),v.string()),
    fingerprint: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_review", ["reviewId"])
    .index("by_github", ["githubId"]),
  conversations: defineTable({
    organizationId: org,
    repositoryId: repo,
    prNumber: v.number(),
    githubCommentId: v.union(v.number(),v.string()),
    nativeP4:v.optional(v.object({reviewId:review,identityId:v.id("p4Identities"),identityGeneration:v.number(),revision:v.string(),polling:p4PollingReference,answerText:v.optional(v.string()),citations:v.optional(v.array(v.object({filePath:v.string(),startLine:v.number(),quote:v.string(),sha:v.string(),url:v.string()}))),lease:v.optional(v.object({id:v.string(),expiresAt:v.number()})),scheduledId:v.optional(v.id("_scheduled_functions")),replyId:v.optional(v.number()),command:v.optional(v.object({kind:v.union(v.literal('ignore-pattern'),v.literal('rereview')),preferenceId:v.optional(v.id('learnedPreferences')),inputStorageId:v.optional(v.id('_storage')),requestedReviewId:v.optional(review)}))})),
    author: v.string(),
    question: v.string(),
    answer: v.optional(v.string()),
    error: v.optional(v.string()),
    attempts: v.optional(v.number()),
    inline: v.optional(v.boolean()),
    parentCommentId: v.optional(v.union(v.number(),v.string())),
    updatedAt: v.optional(v.number()),
    status: v.string(),
    createdAt: v.number(),
  })
    .index("by_pr", ["repositoryId", "prNumber"])
    .index("by_comment", ["githubCommentId"])
    .index("by_repository_comment", ["repositoryId", "githubCommentId"])
    .index("by_native_review", ["nativeP4.reviewId"])
    .index("by_status", ["status"]),
  usageEvents: defineTable({
    organizationId: org,
    repositoryId: repo,
    reviewId: v.optional(review),
    kind: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    estimatedCost: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_repo", ["repositoryId"])
    .index("by_org_time", ["organizationId", "createdAt"]),
  modelCalls: defineTable({
    error: v.optional(v.string()),
    organizationId: org,
    reviewId: review,
    task: v.string(),
    provider: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    latencyMs: v.number(),
    estimatedCost: v.number(),
    cached: v.boolean(),
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_review", ["reviewId"]),
  webhookDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    payloadStorageId: v.id("_storage"),
    status: v.string(),
    attempts: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_delivery", ["deliveryId"])
    .index("by_status", ["status"]),
  apiKeys: defineTable({
    organizationId: org,
    userId: v.id("users"),
    hash: v.string(),
    name: v.string(),
    prefix: v.string(),
    createdAt: v.number(),
    revoked: v.boolean(),
    // read | write | admin; absent on keys created before scopes (they keep full access).
    scopes: v.optional(v.array(v.string())),
  })
    .index("by_hash", ["hash"])
    .index("by_org", ["organizationId"]),
  cliSessions: defineTable({
    userId: v.id("users"),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
});
