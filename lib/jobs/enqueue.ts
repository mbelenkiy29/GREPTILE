import { bullQueue } from "./queue";
import type { JobQueue } from "./types";

/** Queues a full index for freshly connected repos that have never been indexed. */
export async function enqueueIndexForNewRepos(
  repos: { id: number; orgId: string; indexStatus: string; enabled: boolean }[],
  queue: JobQueue = bullQueue,
) {
  for (const r of repos) {
    if (r.enabled && r.indexStatus === "pending") {
      await queue.add("index-repo", { orgId: r.orgId, repoId: r.id, mode: "full" }, { jobId: `index-${r.id}-initial` });
    }
  }
}
