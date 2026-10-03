"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/Chart";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { INDEX_PHASE_LABEL } from "@/components/dashboard/index-phases";
import type { RepoIndexProgress } from "@/lib/data/onboarding";

export const INDEX_STATUS_URL = "/api/orgs/current/index-status";
const POLL_MS = 2000;

function isProgressList(value: unknown): value is { repos: RepoIndexProgress[]; settled: boolean } {
  if (!value || typeof value !== "object") return false;
  const v = value as { repos?: unknown; settled?: unknown };
  return (
    Array.isArray(v.repos) &&
    typeof v.settled === "boolean" &&
    v.repos.every((r) => r && typeof r === "object" && typeof (r as RepoIndexProgress).repoId === "number" && typeof (r as RepoIndexProgress).fullName === "string")
  );
}

function settled(repos: RepoIndexProgress[]) {
  return repos.every((r) => r.indexStatus === "ready" || r.indexStatus === "failed");
}

/** One repository's index state: phase, files done / total, and the error with a retry button when it failed. */
export function RepoProgressRow({ repo, retryAction }: { repo: RepoIndexProgress; retryAction?: (formData: FormData) => Promise<void> }) {
  const job = repo.job;
  const active = job && (job.status === "running" || job.status === "queued");
  const status = active && repo.indexStatus !== "indexing" ? "indexing" : repo.indexStatus;
  const fraction = active && job.filesTotal > 0 ? Math.min(1, job.filesDone / job.filesTotal) : null;
  const error = repo.indexStatus === "failed" ? (repo.indexError ?? job?.error ?? "Indexing failed.") : null;
  return (
    <li className="comment" data-repo={repo.fullName} data-index-status={status}>
      <div className="row">
        <span className="strong break">{repo.fullName}</span>
        <span className="spacer" />
        <StatusPill kind="index" value={status} />
      </div>
      {active && (
        <>
          <ProgressBar value={fraction} label={`Indexing ${repo.fullName}`} />
          <span className="dim">
            {INDEX_PHASE_LABEL[job.phase] ?? job.phase}
            {job.filesTotal > 0 && ` · ${job.filesDone.toLocaleString("en-US")} / ${job.filesTotal.toLocaleString("en-US")} files`}
          </span>
        </>
      )}
      {repo.indexStatus === "ready" && <span className="dim">{repo.fileCount.toLocaleString("en-US")} files indexed</span>}
      {error && (
        <div className="row">
          <span className="error-text break" role="alert">
            {error}
          </span>
          {retryAction && (
            <form action={retryAction}>
              <input type="hidden" name="repoId" value={repo.repoId} />
              <SubmitButton size="sm" icon="refresh" pendingLabel="Queuing…">
                Retry
              </SubmitButton>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Live index progress of the org's enabled repositories (R6.2): polls the index-status endpoint every 2 seconds
 * until every repository is ready or failed.
 */
export function IndexProgressList({ initial, retryAction }: { initial: RepoIndexProgress[]; retryAction?: (formData: FormData) => Promise<void> }) {
  const [repos, setRepos] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const done = settled(repos);

  useEffect(() => {
    if (done) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(INDEX_STATUS_URL, { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body: unknown = await res.json();
        if (!stopped && isProgressList(body)) {
          setRepos(body.repos);
          setError(null);
        }
      } catch {
        if (!stopped) setError("Couldn't refresh indexing progress. Retrying…");
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [done]);

  if (!repos.length) return <p className="empty">No repositories have reviews turned on yet.</p>;
  const ready = repos.filter((r) => r.indexStatus === "ready").length;
  return (
    <div className="stack-sm" data-testid="index-progress">
      <p className="dim" aria-live="polite">
        {ready} of {repos.length} repositor{repos.length === 1 ? "y" : "ies"} indexed{done ? "." : "; this page updates automatically."}
      </p>
      {error && (
        <p className="dim" role="status">
          {error}
        </p>
      )}
      <ul className="comments">
        {repos.map((r) => (
          <RepoProgressRow key={r.repoId} repo={r} retryAction={retryAction} />
        ))}
      </ul>
    </div>
  );
}
