import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeliveriesTable } from "@/components/dashboard/DeliveriesTable";
import { IndexStatus } from "@/components/dashboard/IndexStatus";
import { InstallationHealth } from "@/components/dashboard/InstallationHealth";
import { RepoActions } from "@/components/dashboard/RepoActions";
import { RepoSettingsForm } from "@/components/dashboard/RepoSettingsForm";
import { ReviewsTable } from "@/components/dashboard/ReviewsTable";
import { RulesList } from "@/components/dashboard/RulesList";
import { Alert } from "@/components/ui/Alert";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { Badge, humanize, StatusPill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Stat } from "@/components/ui/Stat";
import { Table } from "@/components/ui/Table";
import { Tabs } from "@/components/ui/Tabs";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { CONFIG_FILE } from "@/lib/config/repo-config";
import { resolveEffectiveSettings } from "@/lib/config/settings";
import { db } from "@/lib/db";
import { listDeliveries } from "@/lib/data/deliveries";
import { activeIndexJobs } from "@/lib/data/overview";
import { getRepoDetail } from "@/lib/data/repos";
import { listReviewPage } from "@/lib/data/reviews";
import { listRules } from "@/lib/data/rules";
import { getRepoSettingsView } from "@/lib/data/settings";
import { siteEnv } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import type { GitHost } from "@/lib/git/types";
import { getIndexStatus, listIndexJobs } from "@/lib/indexer/jobs";
import { formatCount, formatDate, formatDuration, formatRelative, githubCommitUrl, githubRepoUrl, shortSha } from "@/lib/ui/format";
import { enumParam, hrefWith, intParam, queryState, type SearchParams } from "@/lib/ui/url";
import { cancelIndex, reindexRepo, saveRepoSettings, toggleRepo } from "../actions";

export const metadata: Metadata = { title: "Repository" };

const TABS = ["overview", "settings", "rules", "activity"] as const;
type Tab = (typeof TABS)[number];

/** The configured GitHub host, or undefined when the GitHub App isn't configured (the page still renders). */
function optionalHost(): GitHost | undefined {
  try {
    return gitHost();
  } catch {
    return undefined;
  }
}

export default async function RepoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { orgId, role } = await requireOrg();
  const id = Number((await params).id);
  const detail = Number.isSafeInteger(id) ? await getRepoDetail(db(), orgId, id) : undefined;
  if (!detail) notFound();
  const sp = await searchParams;
  const state = queryState(sp);
  const tab: Tab = enumParam(sp, "tab", TABS) ?? "overview";
  const repo = detail.repo;
  const path = `/dashboard/repos/${repo.id}`;
  const githubUrl = siteEnv().GITHUB_WEB_URL;
  const manage = can(role, "repos.manage");
  const jobs = await activeIndexJobs(db(), orgId, [repo.id]);
  const indexJob = jobs.get(repo.id) ?? null;
  const unhealthy =
    detail.installation.suspended || detail.installation.missingPermissions.length
      ? [{ id: detail.installation.id, accountLogin: detail.installation.accountLogin, suspended: detail.installation.suspended, missingPermissions: detail.installation.missingPermissions }]
      : [];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Repositories", href: "/dashboard/repos" }, { label: repo.fullName }]}
        title={repo.fullName}
        meta={
          <>
            {repo.archived ? <Badge>Archived</Badge> : repo.enabled ? <Badge tone="ok" dot>Reviews on</Badge> : <Badge tone="warn" dot>Reviews paused</Badge>}
            <StatusPill kind="index" value={indexJob ? "indexing" : repo.indexStatus} />
            <Badge tone="outline">{humanize(detail.reviewMode)} mode</Badge>
            <span className="dim">
              {detail.installation.accountLogin} · <span className="mono">{repo.defaultBranch}</span> ·{" "}
              <a href={githubRepoUrl(repo.fullName, githubUrl)} target="_blank" rel="noreferrer">
                GitHub
              </a>
            </span>
          </>
        }
        actions={
          <RepoActions
            repo={{ id: repo.id, fullName: repo.fullName, enabled: repo.enabled, archived: repo.archived, indexJob }}
            canManage={manage}
            returnTo={hrefWith(path, state)}
            actions={{ toggle: toggleRepo, reindex: reindexRepo, cancelIndex }}
          />
        }
      />
      <InstallationHealth installations={unhealthy} />
      <Tabs label="Repository sections" pathname={path} state={state} current={tab} tabs={[
        { id: "overview", label: "Overview" },
        { id: "settings", label: "Settings" },
        { id: "rules", label: "Rules" },
        { id: "activity", label: "Activity" },
      ]} />
      {tab === "overview" && <OverviewTab orgId={orgId} repoId={repo.id} detail={detail} state={state} path={path} githubUrl={githubUrl} />}
      {tab === "settings" && <SettingsTab orgId={orgId} repoId={repo.id} editable={can(role, "settings.manage")} />}
      {tab === "rules" && <RulesTab orgId={orgId} repoId={repo.id} />}
      {tab === "activity" && <ActivityTab orgId={orgId} repoId={repo.id} page={intParam(sp, "page")} state={state} path={path} />}
    </>
  );
}

async function OverviewTab({
  orgId,
  repoId,
  detail,
  state,
  path,
  githubUrl,
}: {
  orgId: string;
  repoId: number;
  detail: NonNullable<Awaited<ReturnType<typeof getRepoDetail>>>;
  state: Record<string, string>;
  path: string;
  githubUrl: string;
}) {
  const page = Number(state.page) > 0 ? Number(state.page) : 1;
  const [status, history, recent] = await Promise.all([
    getIndexStatus(db(), orgId, repoId),
    listIndexJobs(db(), orgId, repoId, { page, pageSize: 10 }),
    listReviewPage(db(), orgId, { repoId, pageSize: 5 }),
  ]);
  const repo = detail.repo;
  const languages = Object.entries(repo.languages).sort((a, b) => b[1] - a[1]);
  const languageTotal = languages.reduce((n, [, c]) => n + c, 0);
  const now = new Date();
  return (
    <>
      <AutoRefresh active={Boolean(status?.current)} />
      <div className="grid-kpi">
        <Stat label="Reviews" value={formatCount(detail.stats.reviews)} />
        <Stat label="Open findings" value={formatCount(detail.stats.openFindings)} hint={`${formatCount(detail.stats.resolvedFindings)} resolved`} />
        <Stat label="Files indexed" value={formatCount(repo.fileCount)} />
        <Stat label="Symbols" value={formatCount(repo.symbolCount)} />
      </div>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card title="Index" titleId="index-heading">
          <IndexStatus status={status?.current ? "indexing" : repo.indexStatus} error={repo.indexError} job={status?.current ?? null} repoName={repo.fullName} />
          <dl className="kv">
            <dt>Indexed commit</dt>
            <dd>
              {repo.indexedSha ? (
                <a className="mono" href={githubCommitUrl(repo.fullName, repo.indexedSha, githubUrl)} target="_blank" rel="noreferrer">
                  {shortSha(repo.indexedSha)}
                </a>
              ) : (
                "Not indexed yet"
              )}
            </dd>
            <dt>Indexed</dt>
            <dd>{formatDate(repo.indexedAt)}</dd>
          </dl>
        </Card>
        <Card title="Languages" titleId="languages-heading">
          {languages.length ? (
            <div className="severity-bars">
              {languages.slice(0, 8).map(([lang, n]) => (
                <div key={lang} className="severity-bar">
                  <span className="truncate">{lang}</span>
                  <span className="severity-track" aria-hidden="true">
                    <span style={{ width: `${(n / languageTotal) * 100}%`, background: "var(--accent)" }} />
                  </span>
                  <span className="num dim">{n}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="dim">Languages appear after the first index completes.</p>
          )}
        </Card>
      </div>

      <section className="stack-sm" aria-labelledby="recent-heading">
        <div className="page-head">
          <h2 id="recent-heading">Recent reviews</h2>
          <Link href={`/dashboard/reviews?repo=${repoId}`}>All reviews of this repository</Link>
        </div>
        {recent.items.length ? (
          <ReviewsTable reviews={recent.items} githubUrl={githubUrl} now={now} />
        ) : (
          <EmptyState icon="review" title="No reviews yet" headingLevel={3}>
            <p>Open a pull request on {repo.fullName} and OpenReview reviews it automatically.</p>
          </EmptyState>
        )}
      </section>

      <section className="stack-sm" aria-labelledby="jobs-heading">
        <h2 id="jobs-heading">Index history</h2>
        {history.jobs.length ? (
          <>
            <Table caption="Index runs" compact>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col">Commits</th>
                  <th scope="col" className="num">
                    Changed
                  </th>
                  <th scope="col" className="num">
                    Skipped
                  </th>
                  <th scope="col">Duration</th>
                  <th scope="col">Queued</th>
                </tr>
              </thead>
              <tbody>
                {history.jobs.map((j) => {
                  const skipped = Object.entries(j.progress.filesSkipped ?? {});
                  const skippedTotal = skipped.reduce((n, [, c]) => n + c, 0);
                  return (
                    <tr key={j.id} data-index-job={j.id}>
                      <td>
                        <span className="mono">#{j.id}</span>
                        <div className="cell-sub">
                          {humanize(j.kind)} · {humanize(j.trigger)}
                          {j.attempts > 1 ? ` · ${j.attempts} attempts` : ""}
                        </div>
                      </td>
                      <td style={{ maxWidth: 320 }}>
                        <StatusPill kind="job" value={j.status} />
                        {j.error && <div className="error-text break">{j.error}</div>}
                      </td>
                      <td className="mono nowrap">
                        {j.fromSha ? `${shortSha(j.fromSha)} → ` : ""}
                        {shortSha(j.toSha)}
                      </td>
                      <td className="num">
                        {j.changedFiles.length ? (
                          <details>
                            <summary>
                              {j.progress.filesChanged || j.changedFiles.length}
                              {j.progress.filesRemoved ? ` / −${j.progress.filesRemoved}` : ""}
                            </summary>
                            <ul className="mono dim" style={{ textAlign: "left", margin: 0, paddingLeft: "1em", maxHeight: 200, overflow: "auto" }}>
                              {j.changedFiles.slice(0, 100).map((f) => (
                                <li key={f}>{f}</li>
                              ))}
                            </ul>
                          </details>
                        ) : (
                          j.progress.filesChanged
                        )}
                      </td>
                      <td className="num" title={skipped.map(([r, c]) => `${r}: ${c}`).join(", ") || undefined}>
                        {skippedTotal}
                      </td>
                      <td className="nowrap num">
                        {j.startedAt ? formatDuration((j.finishedAt ?? now).getTime() - j.startedAt.getTime()) : "—"}
                      </td>
                      <td className="nowrap">{formatRelative(j.queuedAt, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pagination pathname={path} state={state} page={history.page} pageCount={Math.max(1, Math.ceil(history.total / history.pageSize))} total={history.total} pageSize={history.pageSize} noun="index runs" />
          </>
        ) : (
          <p className="dim">No index runs recorded yet.</p>
        )}
      </section>
    </>
  );
}

async function SettingsTab({ orgId, repoId, editable }: { orgId: string; repoId: number; editable: boolean }) {
  const view = await getRepoSettingsView(db(), orgId, repoId, { host: optionalHost() });
  if (!view) notFound();
  const inherited = resolveEffectiveSettings(view.orgSettings, undefined, undefined).settings;
  return (
    <div className="stack-md">
      <Alert tone="neutral" title={`${CONFIG_FILE} overrides these settings`}>
        A <code>{CONFIG_FILE}</code> on the default branch overrides dashboard values key by key; badges show where each effective
        value comes from.{" "}
        {view.file.status === "found" && "This repository has one, and values it sets are marked."}
        {view.file.status === "absent" && "This repository doesn't have one."}
        {view.file.status === "not_checked" && "The file couldn't be checked because the GitHub App isn't configured."}
        {!editable && " Only owners and admins can change settings."}
      </Alert>
      {(view.file.status === "invalid" || view.file.status === "unavailable") && view.file.message && (
        <Alert tone="warning" title={view.file.status === "invalid" ? `${CONFIG_FILE} is invalid and ignored` : `${CONFIG_FILE} couldn't be read`}>
          {view.file.message}
        </Alert>
      )}
      <Card>
        <RepoSettingsForm
          repoId={repoId}
          editable={editable}
          action={saveRepoSettings}
          settings={view.settings}
          sources={view.sources}
          inherited={inherited}
          repoSettings={view.repoSettings}
        />
      </Card>
    </div>
  );
}

async function RulesTab({ orgId, repoId }: { orgId: string; repoId: number }) {
  const rows = await listRules(db(), orgId, { status: ["active"], enabled: true });
  const applicable = rows.filter((r) => r.rule.repoId === null || r.rule.repoId === repoId).map((r) => ({ ...r.rule, repoFullName: r.repoFullName }));
  return (
    <div className="stack-md">
      <div className="page-head">
        <p className="dim">
          Active rules that apply to this repository: organization-wide rules and rules scoped to it. Rules in its <code>{CONFIG_FILE}</code>{" "}
          apply too.
        </p>
        <ButtonLink href="/dashboard/rules" size="sm">
          Manage rules
        </ButtonLink>
      </div>
      <RulesList rules={applicable} empty="No rules apply to this repository yet. Add one on the Rules page." />
    </div>
  );
}

async function ActivityTab({ orgId, repoId, page, state, path }: { orgId: string; repoId: number; page?: number; state: Record<string, string>; path: string }) {
  const deliveries = await listDeliveries(db(), orgId, { repoId, page: page ?? 1, pageSize: 25 });
  return (
    <div className="stack-md">
      {deliveries.items.length ? (
        <>
          <DeliveriesTable deliveries={deliveries.items} showRepo={false} />
          <Pagination pathname={path} state={state} page={deliveries.page} pageCount={Math.max(1, Math.ceil(deliveries.total / deliveries.pageSize))} total={deliveries.total} pageSize={deliveries.pageSize} noun="deliveries" />
        </>
      ) : (
        <EmptyState icon="activity" title="No webhook deliveries for this repository" headingLevel={3}>
          <p>GitHub events about this repository (pull requests, pushes, comments) appear here with what OpenReview did about them.</p>
        </EmptyState>
      )}
    </div>
  );
}
