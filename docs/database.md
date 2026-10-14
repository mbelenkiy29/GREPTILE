# Database

The authoritative schema is `convex/schema.ts`. Workspace data is scoped by its organization or authorized parent; identity/session records retain their own principals. Repositories tie installations to workspace ownership. Membership indexes support server authorization; no client supplied organization ID grants access by itself.

Identity: users, organizations, organizationMembers, invitations, githubInstallations, apiKeys, cliSessions.

Workspace scope: teams, teamMembers, scopeSettings, repositoryClusters, auditEvents. Organization/team overrides are stored separately from existing repository settings; removing overrides restores parent inheritance.

The portal stores team selection in an HTTP-only preference cookie and validates it against current workspace membership on every render. Workspace switching clears it. Optional team filters on dashboard, analytics, PR, findings and preference queries call the shared repository-access resolver; team IDs never expand repository access. Findings apply repository authorization before pagination. Workspace administration and authorized direct review links retain their own resource checks.

`settings.summarySections` is optional for legacy rows and defaults to all six configured summary sections. Workspace/team overrides use the existing override-key resolution; a deliberately empty array hides optional sections. Execution status and coverage cannot be hidden. New review results persist the rendered summary, so changing formatting does not rewrite review history.

Provider access: providerConnections, providerReceipts, providerEvents. Connections retain encrypted credentials and native instance/installation identities; receipts are consumed atomically and events have durable status/retry records.

Requirements context: integrationConnections, integrationRevocations. Linear connections store encrypted rotating OAuth credentials, selected team/project/repository IDs, generation counters and refresh leases. Disconnect erases active credentials and bindings, increments generation, invalidates model cache, and keeps an encrypted revocation-job credential only until success or three failed attempts. Revocation leases recover interrupted actions. Issue bodies are fetched for a review and are not stored as a separate issue cache; published review evidence remains historical.

Agent access: personalSettings, bridgeDevices, fixRequests. Pairing credentials are hashed, scoped, expiring and revocable. Single-use fix requests retain the reviewed head, selected agent, authorized prompt and truthful dispatch status. A claimed request can become launched or failed; a launched request can become finished (zero process exit) or failed. Terminal states cannot be overwritten, and none changes finding resolution. Legacy launched requests remain launched without fabricated exit evidence.

`organizations.defaultAgent` is optional; existing workspaces default to Codex. A `personalSettings` row explicitly overrides the workspace default across workspaces; resetting deletes that override. Workspace changes require owner/admin access and create an audit event. The personal query accepts an optional workspace scope, authorizes membership and filters paired devices to it. Legacy unscoped callers retain their personal preference/Codex fallback. Workspace viewers can select a personal preference but cannot pair a bridge or dispatch fixes.

Opt-in automation: runtimePolicies, runtimeWorkers, runtimeJobs, approvalPolicies, approvalJobs. Durable jobs retain exact revisions, trusted policy snapshots/keys and leases; runtime logs and approval reasons are independent from model prose. Worker credentials are hashed and revocable.

`approvalJobs.by_org_status` supports paginated rechecks of blocked jobs after trusted policy edits. Each page schedules only the edited workspace and repository/team scope; periodic sweeps continue to handle active approvals and waiting checks without repeatedly reading every blocked job from providers. The additive index requires a normal Convex deployment and no record backfill.

Repository context: repositories, repositorySettings, repositoryFiles, symbols, relationships, indexJobs, codeChunks, embeddings, knowledgeEntries.

Review state: pullRequests, pullRequestCommits, reviews, reviewRuns, agentRuns, findings, reviewFindings, reviewComments, conversations.

Feedback/configuration: findingFeedback, learnedPreferences, customRules.

New learned preferences retain their originating finding, feedback or conversation, review ID, and update timestamp. These fields are optional for legacy rows; the inspector reports an unknown original revision rather than inferring it from a mutable finding. Disabling preserves provenance; resetting removes the preference. Both require repository administrator access. Feedback requires repository write access. Replayed explicit suppression requests reuse their conversation identity and do not re-enable a disabled preference.

Operations: webhookDeliveries, modelCalls, usageEvents, modelCache, rateLimits.

Repository files and full review/webhook payloads use Convex storage blobs. Updating file content deletes superseded blobs and replaces graph nodes/edges for that file. Successful indexing prunes deleted files. Stable finding fingerprints combine path/category/symbol/title/evidence; semantic text overlap catches closely matching same-location issues. Finding statuses remain independent from review job state.

Indexes are declared per organization, repository, PR, head SHA, path, symbol, fingerprint, delivery ID, and API key hash. Convex mutations serialize conflicting claims, preserving delivery/job deduplication. Scheduled actions survive browser refresh and persist across backend restart. Back up both database state and blob storage; database-only backups are insufficient.

Deploy schema changes with `pnpm exec convex dev --once` locally or the self-hosted deployment command in `docs/deployment.md`. Do not reset a deployment to fix schema errors. Use additive changes/migrations for existing production data.

`reviewFindings` preserves immutable source evidence for each review; `findings` tracks the current lifecycle. Legacy snapshots can be recovered from the original saved result using `pnpm exec convex run jobs:backfillReviewFindings '{"reviewId":"<review-id>"}'` with deployment administrator authentication. Missing or mismatched original results fail visibly rather than reconstructing evidence from mutable findings.

`integrationConnections` supports Linear and Atlassian, with encrypted credentials, scope generation, selected repositories, and native site/project/space identities. Atlassian selection fields are optional for existing Linear rows; disconnect clears them and credentials. Existing Linear revocation jobs retain their provider-native flow.

PR event intake adds optional `pullRequests.nativeObservedAt` (native read start timestamp, stale observations rejected) and `revisionKey` (provider-specific revision identity). Existing records remain valid. Review ingestion owns review snapshots and does not replace metadata owned by native intake. No indexes are removed by this migration.

`pullCatalogJobs` stores repository/org binding, a digest of provider/repository/credential authority, queued/running/completed/failed/cancelled state, native cursor and hashes of seen cursors, checkpoint counts, bounded retry/error state and an expiring worker lease. `by_repo` locates latest import; `by_status` supports recovery. Native rows are written atomically with page checkpoint and current authority verification. A minute cron starts separate queued/running recovery chains, each reading 100 jobs per mutation and scheduling the next cursor page until exhausted. Live leases and pending/in-progress dispatches are retained; expired work receives one pending dispatch even under overlapping sweeps. Import never calls inference or enqueues a review. No external credentials are stored in jobs. Existing enabled repositories require explicit sync unless they are re-enabled; no migration-wide source indexing or inference backfill runs.

Git provider credential replacement preserves providerConnections identity and webhook credentials. A native discovery proof is committed only after current admin authorization, previous-ciphertext comparison and exact selected repository identity/name checks. provider.credentials_replaced audit events contain the connection ID, never tokens. Existing authority digests cause old jobs to fail closed after replacement.
