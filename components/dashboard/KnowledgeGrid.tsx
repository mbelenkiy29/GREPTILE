import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge, humanize } from "@/components/ui/Badge";
import { Icon, type IconName } from "@/components/ui/icons";
import type { KnowledgeKind } from "@/lib/db/schema";
import type { KnowledgeListItem, KnowledgeRun } from "@/lib/data/knowledge";
import { formatCount, formatRelative, shortSha } from "@/lib/ui/format";

export const KIND_ICONS: Record<KnowledgeKind, IconName> = {
  architecture: "overview",
  authentication: "shield",
  authorization: "team",
  database: "source",
  api: "code",
  background_jobs: "clock",
  billing: "usage",
  integrations: "spark",
  testing: "check",
  deployment: "play",
  security: "shield",
  frontend: "monitor",
  other: "repo",
};

const KIND_LABELS: Partial<Record<KnowledgeKind, string>> = { api: "API", background_jobs: "Background jobs" };

export function kindLabel(kind: KnowledgeKind): string {
  return KIND_LABELS[kind] ?? humanize(kind);
}

/** Freshness of an entry: not generated yet, stale (its files changed), or current. */
export function FreshnessBadge({ entry }: { entry: Pick<KnowledgeListItem, "stale" | "lastUpdatedAt" | "lastError"> }) {
  if (!entry.lastUpdatedAt) return <Badge tone={entry.lastError ? "bad" : "muted"} dot>{entry.lastError ? "Generation failed" : "Not generated yet"}</Badge>;
  if (entry.stale) return <Badge tone="warn" dot title="Files of this subsystem changed since the entry was generated">Stale</Badge>;
  return <Badge tone="ok" dot>Current</Badge>;
}

/** Knowledge entries as a grid of cards (R6.12): kind icon, title, freshness, summary, and the commit it reflects. */
export function KnowledgeGrid({ entries, now }: { entries: KnowledgeListItem[]; now: Date }) {
  return (
    <ul className="knowledge-grid" aria-label="Knowledge entries">
      {entries.map((e) => (
        <li key={e.id} className="card knowledge-card" data-knowledge-entry={e.slug}>
          <div className="row-tight">
            <span className="knowledge-icon" aria-hidden="true">
              <Icon name={KIND_ICONS[e.kind]} size={16} />
            </span>
            <Link className="cell-title" href={`/dashboard/knowledge/${e.id}`}>
              {e.title}
            </Link>
          </div>
          <div className="row-tight">
            <Badge tone="outline">{kindLabel(e.kind)}</Badge>
            <FreshnessBadge entry={e} />
            {e.source === "edited" && <Badge tone="accent">Edited</Badge>}
            {e.hasProposal && <Badge tone="info">Update proposed</Badge>}
          </div>
          <p className="dim knowledge-summary">{e.summary || (e.lastUpdatedAt ? "No description." : "Queued for generation.")}</p>
          <div className="dim row-tight">
            <span>{formatCount(e.fileCount)} files</span>
            {e.risks > 0 && <span>· {formatCount(e.risks)} risks</span>}
            <span>
              ·{" "}
              {e.lastCommitSha ? (
                <>
                  <span className="mono">{shortSha(e.lastCommitSha)}</span> {formatRelative(e.lastUpdatedAt, now)}
                </>
              ) : (
                "never updated"
              )}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The latest refresh run: skipped (with why), failed, running, or what it did. */
export function KnowledgeRunNotice({ run, now }: { run: KnowledgeRun | null; now: Date }) {
  if (!run) return null;
  if (run.status === "skipped") {
    return (
      <Alert tone="warning" title="The last knowledge refresh was skipped">
        {run.reason ?? "No reason recorded."} ({formatRelative(run.finishedAt ?? run.createdAt, now)})
      </Alert>
    );
  }
  if (run.status === "failed") {
    return (
      <Alert tone="error" title="The last knowledge refresh failed">
        {run.reason ?? "No reason recorded."} ({formatRelative(run.finishedAt ?? run.createdAt, now)})
      </Alert>
    );
  }
  if (run.status === "queued" || run.status === "running") {
    return (
      <Alert tone="info" title={run.status === "running" ? "Refreshing knowledge…" : "Knowledge refresh queued"}>
        {run.mode === "entry" ? "One entry is being regenerated." : "Stale entries are regenerated a few at a time; this page updates as they finish."}
      </Alert>
    );
  }
  return (
    <p className="dim" data-knowledge-run={run.id}>
      Last refresh {formatRelative(run.finishedAt, now)}: {formatCount(run.discovered)} subsystems found, {formatCount(run.generated)} regenerated
      {run.failed ? `, ${formatCount(run.failed)} failed` : ""}
      {run.remaining ? `, ${formatCount(run.remaining)} still stale (picked up by the next run)` : ""}.
    </p>
  );
}
