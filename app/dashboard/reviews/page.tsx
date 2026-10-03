import type { Metadata } from "next";
import { ReviewsTable } from "@/components/dashboard/ReviewsTable";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { humanize } from "@/components/ui/Badge";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { repoOptions } from "@/lib/data/repos";
import { listReviewPage, REVIEW_STATUSES } from "@/lib/data/reviews";
import { siteEnv } from "@/lib/env";
import { REVIEW_MODES } from "@/lib/llm/types";
import { enumParam, intParam, queryState, type SearchParams } from "@/lib/ui/url";

export const metadata: Metadata = { title: "Reviews" };

const PATH = "/dashboard/reviews";

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId } = await requireOrg();
  const sp = await searchParams;
  const state = queryState(sp);
  const filter = {
    repoId: intParam(sp, "repo"),
    status: enumParam(sp, "status", REVIEW_STATUSES),
    mode: enumParam(sp, "mode", REVIEW_MODES),
  };
  const filtered = Boolean(filter.repoId || filter.status || filter.mode);
  const [page, repos] = await Promise.all([listReviewPage(db(), orgId, { ...filter, page: intParam(sp, "page"), pageSize: 25 }), repoOptions(db(), orgId)]);
  const active = page.items.some((r) => r.status === "queued" || r.status === "running");

  return (
    <>
      <PageHeader title="Reviews" description="Every pull request OpenReview reviewed, newest activity first." />
      <AutoRefresh active={active} />
      {page.total === 0 && !filtered ? (
        <EmptyState
          icon="review"
          title="No reviews yet"
          actions={<ButtonLink href="/dashboard/repos">Check repositories</ButtonLink>}
        >
          <p>Open a pull request on a connected repository and a review appears here within a minute or two.</p>
        </EmptyState>
      ) : (
        <>
          <form className="filter-bar" action={PATH} aria-label="Filter reviews">
            <div className="field">
              <label className="field-label" htmlFor="flt-repo">
                Repository
              </label>
              <select id="flt-repo" name="repo" className="select" defaultValue={filter.repoId ? String(filter.repoId) : ""}>
                <option value="">All repositories</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="flt-status">
                Status
              </label>
              <select id="flt-status" name="status" className="select" defaultValue={filter.status ?? ""}>
                <option value="">Any status</option>
                {REVIEW_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="flt-mode">
                Mode
              </label>
              <select id="flt-mode" name="mode" className="select" defaultValue={filter.mode ?? ""}>
                <option value="">Any mode</option>
                {REVIEW_MODES.map((m) => (
                  <option key={m} value={m}>
                    {humanize(m)}
                  </option>
                ))}
              </select>
            </div>
            <div className="filter-bar-actions">
              <button className="button" type="submit">
                Apply
              </button>
              {filtered && (
                <ButtonLink href={PATH} variant="ghost">
                  Reset
                </ButtonLink>
              )}
            </div>
          </form>
          {page.items.length ? (
            <ReviewsTable reviews={page.items} githubUrl={siteEnv().GITHUB_WEB_URL} />
          ) : (
            <EmptyState icon="filter" title="No reviews match these filters" headingLevel={3} actions={<ButtonLink href={PATH}>Reset filters</ButtonLink>} />
          )}
          <Pagination pathname={PATH} state={state} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun="reviews" />
        </>
      )}
    </>
  );
}
