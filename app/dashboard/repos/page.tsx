import type { Metadata } from "next";
import { RepoActions } from "@/components/dashboard/RepoActions";
import { ReposTable } from "@/components/dashboard/ReposTable";
import { Alert } from "@/components/ui/Alert";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { requireOrg } from "@/lib/auth";
import { installMessage } from "@/lib/auth/messages";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listRepoOverview, unhealthyInstallations } from "@/lib/data/repos";
import { siteEnv } from "@/lib/env";
import { hrefWith, intParam, param, queryState, type SearchParams } from "@/lib/ui/url";
import { InstallationHealth } from "@/components/dashboard/InstallationHealth";
import { cancelIndex, reindexRepo, toggleRepo } from "./actions";

export const metadata: Metadata = { title: "Repositories" };

const PATH = "/dashboard/repos";

export default async function ReposPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId, role } = await requireOrg();
  const sp = await searchParams;
  const state = queryState(sp);
  const manage = can(role, "repos.manage");
  const q = param(sp, "q");
  const [page, unhealthy] = await Promise.all([
    listRepoOverview(db(), orgId, { page: intParam(sp, "page"), pageSize: 25, q }),
    unhealthyInstallations(db(), orgId),
  ]);
  const install = param(sp, "install");
  const message = installMessage(install);
  const returnTo = hrefWith(PATH, state);
  const indexing = page.items.some((r) => r.indexJob !== null || r.indexStatus === "indexing");

  return (
    <>
      <PageHeader
        title="Repositories"
        description="Repositories connected through the GitHub App, GitLab, or Bitbucket, their index, and how they're reviewed."
        actions={
          manage && (
            <>
              <ButtonLink href="/dashboard/settings/git-providers" icon="gitlab">
                GitLab / Bitbucket
              </ButtonLink>
              <ButtonLink href="/api/github/install" variant="primary" icon="github">
                {page.total ? "Add repositories" : "Connect GitHub"}
              </ButtonLink>
            </>
          )
        }
      />
      {message && (
        <Alert tone={install === "ok" || install === "requested" ? "success" : "error"}>{message}</Alert>
      )}
      <InstallationHealth installations={unhealthy} />
      <AutoRefresh active={indexing} />

      {page.total === 0 && !q ? (
        <EmptyState
          icon="repo"
          title="No repositories connected yet"
          actions={
            manage ? (
              <>
                <ButtonLink href="/api/github/install" variant="primary" icon="github">
                  Install the GitHub App
                </ButtonLink>
                <ButtonLink href="/dashboard/settings/git-providers" icon="gitlab">
                  Connect GitLab or Bitbucket
                </ButtonLink>
                <ButtonLink href="/onboarding">Start onboarding</ButtonLink>
              </>
            ) : undefined
          }
        >
          <p>
            Install the OpenReview GitHub App on an account and choose repositories. Each one is indexed so reviews see the
            whole codebase, not just the diff.
          </p>
          {!manage && <p>Ask an owner or admin of this organization to connect GitHub.</p>}
        </EmptyState>
      ) : (
        <>
          <form className="filter-bar" role="search" action={PATH}>
            <div className="field">
              <label className="field-label" htmlFor="repo-q">
                Find a repository
              </label>
              <input id="repo-q" className="input" name="q" defaultValue={q ?? ""} placeholder="owner/name" />
            </div>
            <div className="filter-bar-actions">
              <button className="button" type="submit">
                Search
              </button>
              {q && (
                <ButtonLink href={PATH} variant="ghost">
                  Clear
                </ButtonLink>
              )}
            </div>
          </form>
          {page.items.length === 0 ? (
            <EmptyState icon="filter" title="No matching repositories" headingLevel={3}>
              <p>Nothing matches “{q}”. Try part of the owner or repository name.</p>
            </EmptyState>
          ) : (
            <ReposTable
              repos={page.items}
              githubUrl={siteEnv().GITHUB_WEB_URL}
              actions={(r) => (
                <RepoActions repo={r} canManage={manage} returnTo={returnTo} actions={{ toggle: toggleRepo, reindex: reindexRepo, cancelIndex }} />
              )}
            />
          )}
          <Pagination pathname={PATH} state={state} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun="repositories" />
        </>
      )}
    </>
  );
}
