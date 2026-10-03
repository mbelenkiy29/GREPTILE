/** Correlation data carried by every job so its logs tie back to what caused it (R6.21). */
export interface JobMeta {
  /** Webhook delivery that enqueued the job. */
  deliveryId?: string;
  /** User (or API key) that asked for the job from the dashboard, API, or CLI. */
  requestedBy?: string;
}

/**
 * What caused a review run (R6.6): a `pull_request` webhook action, a person (dashboard re-review, `@mention`
 * command, REST API, CLI), or restart recovery re-queuing an abandoned run.
 */
export type ReviewTrigger =
  | "opened"
  | "synchronize"
  | "reopened"
  | "ready_for_review"
  | "manual"
  | "mention"
  | "api"
  | "cli"
  | "recovery";

/** Where a mention was written; decides where the answer is posted. */
export type MentionKind = "issue_comment" | "review_comment" | "review";

export interface JobPayloads {
  "index-repo": {
    orgId: string;
    repoId: number;
    mode: "full" | "incremental";
    afterSha?: string;
    /** What caused the run (R6.3); inferred when absent. */
    trigger?: "install" | "push" | "default_branch" | "manual" | "schedule" | "api";
    /** Tracked `index_jobs` row created when the job was queued; one is created when absent. */
    indexJobId?: number;
    meta?: JobMeta;
  };
  "review-pr": {
    /**
     * The tracked `review_runs` row (R6.6) created by `requestReview`. Jobs queued before runs existed carry only
     * the PR fields below; the job creates a run for them.
     */
    runId?: number;
    orgId: string;
    repoId: number;
    prNumber: number;
    /** Head the run was requested for, when known (the run reviews the PR's head at start otherwise). */
    headSha?: string;
    trigger?: ReviewTrigger;
    meta?: JobMeta;
  };
  "sync-feedback": { orgId: string; repoId: number; prNumber: number; meta?: JobMeta };
  "mine-rules": { orgId: string; repoId: number; meta?: JobMeta };
  /** Refreshes the repository knowledge base (R6.12) for a tracked `knowledge_runs` row. */
  "refresh-knowledge": { orgId: string; repoId: number; runId: number; meta?: JobMeta };
  "answer-mention": {
    orgId: string;
    repoId: number;
    prNumber: number;
    /** The comment (or review) that mentions the bot; each is answered at most once. */
    commentId: number;
    body: string;
    author: string;
    /** Defaults to `issue_comment` (jobs queued before threads existed). */
    kind?: MentionKind;
    /** For `review_comment`: the thread's top-level comment, which the answer replies to. */
    inReplyTo?: number;
    path?: string;
    line?: number | null;
    /**
     * The commenter's GitHub `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...). Commands that
     * change state (re-review, ignore pattern, feedback) need OWNER, MEMBER, or COLLABORATOR (R6.17).
     */
    authorAssociation?: string;
    meta?: JobMeta;
  };
}

export type JobName = keyof JobPayloads;

export interface JobOptions {
  /** Deterministic id: adding a job whose id is already queued, running, or recently finished is a no-op. */
  jobId: string;
  /** Lower runs first. Defaults to {@link JOB_PRIORITY} for the job name. */
  priority?: number;
  /** Milliseconds to wait before the job becomes runnable. */
  delay?: number;
}

/** Default priorities (lower runs first): mentions, then reviews, then feedback, indexing, rule mining, and knowledge. */
export const JOB_PRIORITY: Record<JobName, number> = {
  "answer-mention": 1,
  "review-pr": 2,
  "sync-feedback": 3,
  "index-repo": 4,
  "mine-rules": 5,
  "refresh-knowledge": 6,
};

/**
 * Where a queued job is: `pending` (waiting, delayed, or running), `failed` (gave up after its attempts), `done`
 * (completed), or `missing` (unknown to the queue, e.g. lost or already removed).
 */
export type QueuedJobState = "pending" | "failed" | "done" | "missing";

export interface JobQueue {
  /** `jobId` dedupes: adding a job whose id is already queued or running is a no-op. */
  add<N extends JobName>(name: N, data: JobPayloads[N], opts: JobOptions): Promise<void>;
  /** Looks a job up by id (restart recovery uses it to leave runs whose job is only waiting alone). */
  jobState?(jobId: string): Promise<QueuedJobState>;
}

/** In-process queue used by tests and local scripts. */
export class MemoryQueue implements JobQueue {
  readonly jobs: { name: JobName; data: JobPayloads[JobName]; jobId: string; priority: number; delay?: number }[] = [];
  /** Jobs a test marked as finished (`settle`); every other added job counts as pending. */
  readonly settled = new Map<string, "done" | "failed">();

  settle(jobId: string, state: "done" | "failed") {
    this.settled.set(jobId, state);
  }

  async jobState(jobId: string): Promise<QueuedJobState> {
    const settled = this.settled.get(jobId);
    if (settled) return settled;
    return this.jobs.some((j) => j.jobId === jobId) ? "pending" : "missing";
  }

  async add<N extends JobName>(name: N, data: JobPayloads[N], opts: JobOptions) {
    if (this.jobs.some((j) => j.jobId === opts.jobId)) return;
    this.jobs.push({
      name,
      data,
      jobId: opts.jobId,
      priority: opts.priority ?? JOB_PRIORITY[name],
      ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
    });
  }
}
