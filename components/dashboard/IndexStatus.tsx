import { ProgressBar } from "@/components/ui/Chart";
import { StatusPill } from "@/components/ui/Badge";
import { indexProgressFraction } from "@/lib/data/overview";
import type { IndexProgress } from "@/lib/db/schema";
import { formatCount } from "@/lib/ui/format";

const PHASE_LABEL: Record<string, string> = {
  queued: "Waiting to start",
  checkout: "Checking out",
  scan: "Scanning files",
  parse: "Parsing",
  embed: "Embedding",
  graph: "Building graph",
  finalize: "Finalizing",
  done: "Done",
};

/** A repository's index state; while a job is queued or running, its phase and a live progress bar. */
export function IndexStatus({
  status,
  error,
  job,
  repoName,
}: {
  status: string;
  error?: string | null;
  job?: { status: string; kind: string; progress: IndexProgress } | null;
  repoName: string;
}) {
  const active = job && (job.status === "running" || job.status === "queued");
  const fraction = active ? (job.status === "queued" ? null : indexProgressFraction(job.progress)) : null;
  return (
    <div className="stack-sm" style={{ gap: 6, minWidth: 140 }} data-index-status={status}>
      <StatusPill kind="index" value={active && status !== "indexing" ? "indexing" : status} />
      {active && (
        <>
          <ProgressBar value={fraction} label={`Indexing ${repoName}`} />
          <span className="dim">
            {job.kind === "full" ? "Full" : "Incremental"} · {PHASE_LABEL[job.progress.phase] ?? job.progress.phase}
            {job.progress.phase === "parse" && job.progress.filesChanged > 0 && (
              <>
                {" "}
                {formatCount(job.progress.filesDone)}/{formatCount(job.progress.filesChanged)} files
              </>
            )}
          </span>
        </>
      )}
      {status === "failed" && error && <div className="error-text break">{error}</div>}
    </div>
  );
}
