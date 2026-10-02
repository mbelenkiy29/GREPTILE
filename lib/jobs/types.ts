/** Correlation data carried by every job so its logs tie back to what caused it (R6.21). */
export interface JobMeta {
  /** Webhook delivery that enqueued the job. */
  deliveryId?: string;
  /** User (or API key) that asked for the job from the dashboard, API, or CLI. */
  requestedBy?: string;
}

/** What caused a review: the `pull_request` action, or a manual request. */
export type ReviewTrigger = "opened" | "synchronize" | "reopened" | "ready_for_review" | "manual";

/** Where a mention was written; decides where the answer is posted. */
export type MentionKind = "issue_comment" | "review_comment" | "review";

export interface JobPayloads {
  "index-repo": {
    orgId: string;
    repoId: number;
    mode: "full" | "incremental";
    afterSha?: string;
    trigger?: "push" | "install" | "default_branch" | "manual";
    meta?: JobMeta;
  };
  "review-pr": {
    orgId: string;
    repoId: number;
    prNumber: number;
    headSha: string;
    trigger?: ReviewTrigger;
    meta?: JobMeta;
  };
  "sync-feedback": { orgId: string; repoId: number; prNumber: number; meta?: JobMeta };
  "mine-rules": { orgId: string; repoId: number; meta?: JobMeta };
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

/** Default priorities (lower runs first): mentions, then reviews, then feedback, indexing, and rule mining. */
export const JOB_PRIORITY: Record<JobName, number> = {
  "answer-mention": 1,
  "review-pr": 2,
  "sync-feedback": 3,
  "index-repo": 4,
  "mine-rules": 5,
};

export interface JobQueue {
  /** `jobId` dedupes: adding a job whose id is already queued or running is a no-op. */
  add<N extends JobName>(name: N, data: JobPayloads[N], opts: JobOptions): Promise<void>;
}

/** In-process queue used by tests and local scripts. */
export class MemoryQueue implements JobQueue {
  readonly jobs: { name: JobName; data: JobPayloads[JobName]; jobId: string; priority: number; delay?: number }[] = [];

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
