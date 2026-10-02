export interface JobPayloads {
  "index-repo": {
    orgId: string;
    repoId: number;
    mode: "full" | "incremental";
    afterSha?: string;
    /** What caused the run (R6.3); inferred when absent. */
    trigger?: "install" | "push" | "manual" | "schedule" | "api";
    /** Tracked `index_jobs` row created when the job was queued; one is created when absent. */
    indexJobId?: number;
  };
  "review-pr": { orgId: string; repoId: number; prNumber: number; headSha: string };
  "sync-feedback": { orgId: string; repoId: number; prNumber: number };
  "mine-rules": { orgId: string; repoId: number };
  "answer-mention": {
    orgId: string;
    repoId: number;
    prNumber: number;
    commentId: number;
    body: string;
    author: string;
  };
}

export type JobName = keyof JobPayloads;

export interface JobQueue {
  /** `jobId` dedupes: adding a job whose id is already queued or running is a no-op. */
  add<N extends JobName>(name: N, data: JobPayloads[N], opts: { jobId: string }): Promise<void>;
}

/** In-process queue used by tests and local scripts. */
export class MemoryQueue implements JobQueue {
  readonly jobs: { name: JobName; data: JobPayloads[JobName]; jobId: string }[] = [];

  async add<N extends JobName>(name: N, data: JobPayloads[N], opts: { jobId: string }) {
    if (this.jobs.some((j) => j.jobId === opts.jobId)) return;
    this.jobs.push({ name, data, jobId: opts.jobId });
  }
}
