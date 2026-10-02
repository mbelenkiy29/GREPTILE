import { bullQueue } from "./queue";
import type { JobMeta, JobQueue } from "./types";

/** Queues a full index for freshly connected repos that have never been indexed. */
export async function enqueueIndexForNewRepos(
  repos: { id: number; orgId: string; indexStatus: string; enabled: boolean; archived?: boolean }[],
  queue: JobQueue = bullQueue,
  meta?: JobMeta,
) {
  const jobs: string[] = [];
  for (const r of repos) {
    if (r.enabled && !r.archived && r.indexStatus === "pending") {
      const jobId = `index-${r.id}-initial`;
      await queue.add(
        "index-repo",
        { orgId: r.orgId, repoId: r.id, mode: "full", trigger: "install", ...(meta ? { meta } : {}) },
        { jobId },
      );
      jobs.push(jobId);
    }
  }
  return jobs;
}
