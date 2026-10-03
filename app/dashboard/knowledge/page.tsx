import type { Metadata } from "next";
import Link from "next/link";
import { KnowledgeGrid, KnowledgeRunNotice } from "@/components/dashboard/KnowledgeGrid";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { StatusPill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { knowledgeEnabled, latestKnowledgeRuns, listKnowledgeEntries, listKnowledgeRepos } from "@/lib/data/knowledge";
import { STALE_RUN_MS } from "@/lib/knowledge/refresh";
import { formatCount } from "@/lib/ui/format";
import { hrefWith, intParam, queryState, type SearchParams } from "@/lib/ui/url";
import { regenerateKnowledge } from "./actions";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId, role } = await requireOrg();
  const sp = await searchParams;
  const state = queryState(sp);
  const repos = await listKnowledgeRepos(db(), orgId);
  const requested = intParam(sp, "repo");
  // Only repositories of this org can be selected; an unknown id falls back to the first one.
  const repo = repos.find((r) => r.id === requested) ?? repos.find((r) => r.entries > 0) ?? repos[0];
  const enabled = knowledgeEnabled();
  const admin = can(role, "repos.manage");
  const now = new Date();
  const path = "/dashboard/knowledge";

  const header = (
    <PageHeader
      title="Knowledge"
      description="Subsystem notes OpenReview writes from each repository's index — what the code does, its key files, conventions, and risks — refreshed as the code changes and used as review context."
    />
  );
  if (!repo) {
    return (
      <>
        {header}
        <EmptyState icon="knowledge" title="No repositories connected yet" actions={<ButtonLink href="/dashboard/repos">Connect a repository</ButtonLink>}>
          <p>Knowledge is generated from a repository&apos;s code index after it is first indexed.</p>
        </EmptyState>
      </>
    );
  }

  const [entries, runs] = await Promise.all([listKnowledgeEntries(db(), orgId, repo.id, { page: intParam(sp, "page") }), latestKnowledgeRuns(db(), orgId, repo.id)]);
  const latest = runs.latest;
  // A pending run older than the abandoned-run window lost its job; it does not keep the page polling.
  const active = !!latest && (latest.status === "queued" || latest.status === "running") && now.getTime() - (latest.startedAt ?? latest.createdAt).getTime() < STALE_RUN_MS;
  const returnTo = hrefWith(path, state, { repo: repo.id });

  return (
    <>
      {header}
      <AutoRefresh active={active} />
      <div className="filter-bar">
        <form method="get" action={path} className="row" aria-label="Choose a repository" style={{ alignItems: "end" }}>
        <div className="field">
          <label className="field-label" htmlFor="knowledge-repo">
            Repository
          </label>
          <select id="knowledge-repo" name="repo" className="select" defaultValue={String(repo.id)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
                {r.entries ? ` (${r.entries} entries${r.stale ? `, ${r.stale} stale` : ""})` : ""}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button">
          Show
        </button>
        </form>
        <span className="spacer" />
        <StatusPill kind="index" value={repo.indexStatus} />
        <Link href={`/dashboard/repos/${repo.id}`}>Repository details</Link>
        {admin && enabled && repo.indexedSha && (
          <form action={regenerateKnowledge}>
            <input type="hidden" name="repoId" value={repo.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <SubmitButton icon="refresh" size="sm" pendingLabel="Queuing…" disabled={active}>
              Regenerate all
            </SubmitButton>
          </form>
        )}
      </div>

      {!enabled ? (
        <EmptyState icon="knowledge" title="The knowledge base is turned off">
          <p>
            This deployment sets <code>KNOWLEDGE_ENABLED=false</code>, so no subsystem notes are generated. Reviews still use the code index, context
            files, and rules.
          </p>
        </EmptyState>
      ) : !repo.indexedSha ? (
        <EmptyState icon="knowledge" title={`${repo.fullName} hasn't been indexed yet`} actions={<ButtonLink href={`/dashboard/repos/${repo.id}`}>View indexing</ButtonLink>}>
          <p>Knowledge entries are generated from the index once the first index run completes.</p>
        </EmptyState>
      ) : (
        <>
          <KnowledgeRunNotice run={runs.latest} now={now} />
          {entries.items.length ? (
            <>
              <p className="dim">
                {formatCount(entries.total)} subsystem{entries.total === 1 ? "" : "s"} in {repo.fullName}
                {repo.stale ? ` · ${formatCount(repo.stale)} stale` : ""}
              </p>
              <KnowledgeGrid entries={entries.items} now={now} />
              <Pagination pathname={path} state={{ ...state, repo: String(repo.id) }} page={entries.page} pageCount={entries.pageCount} total={entries.total} pageSize={entries.pageSize} noun="entries" />
            </>
          ) : (
            <EmptyState icon="knowledge" title="No knowledge entries yet" headingLevel={3}>
              <p>
                {active
                  ? "The first knowledge refresh is running; entries appear here as they're generated."
                  : admin
                    ? "Entries are generated after indexing. Use Regenerate all to build them now."
                    : "Entries are generated after indexing completes."}
              </p>
            </EmptyState>
          )}
        </>
      )}
    </>
  );
}
