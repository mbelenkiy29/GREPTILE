import type { Metadata } from "next";
import { FindingsTable } from "@/components/dashboard/FindingsTable";
import { humanize } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { FINDING_SORTS, findingFacets, searchFindings, type FindingSearch, type FindingStatus } from "@/lib/data/findings";
import { repoOptions } from "@/lib/data/repos";
import { findingStatus } from "@/lib/db/schema";
import { SEVERITIES } from "@/lib/engine/types";
import { siteEnv } from "@/lib/env";
import { dateParam, enumParam, intParam, param, params, queryState, type SearchParams } from "@/lib/ui/url";

export const metadata: Metadata = { title: "Findings" };

const PATH = "/dashboard/findings";
const STATUSES = findingStatus.enumValues;

/** Reads the findings filters from the URL; unknown values are dropped. New filters are added here. */
function readFilter(sp: SearchParams): FindingSearch {
  const to = dateParam(sp, "to");
  return {
    repoId: intParam(sp, "repo"),
    severity: params(sp, "severity").filter((s) => (SEVERITIES as readonly string[]).includes(s)),
    category: params(sp, "category").slice(0, 20),
    status: params(sp, "status").filter((s): s is FindingStatus => (STATUSES as readonly string[]).includes(s)),
    author: param(sp, "author")?.slice(0, 100),
    from: dateParam(sp, "from"),
    // "to" is inclusive in the UI: findings created on that day are included.
    to: to ? new Date(to.getTime() + 86_400_000) : undefined,
    agent: param(sp, "agent")?.slice(0, 100),
    sort: enumParam(sp, "sort", FINDING_SORTS),
    dir: enumParam(sp, "dir", ["asc", "desc"] as const),
    page: intParam(sp, "page"),
    pageSize: 25,
  };
}

function Select({ id, name, label, value, options, any }: { id: string; name: string; label: string; value: string; options: { value: string; label: string }[]; any: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} name={name} className="select" defaultValue={value}>
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default async function FindingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId } = await requireOrg();
  const sp = await searchParams;
  const state = queryState(sp);
  const filter = readFilter(sp);
  const [page, facets, repos] = await Promise.all([searchFindings(db(), orgId, filter), findingFacets(db(), orgId), repoOptions(db(), orgId)]);
  const filtered = ["repo", "severity", "category", "status", "author", "from", "to", "agent"].some((k) => state[k]);

  return (
    <>
      <PageHeader title="Findings" description="Everything OpenReview has flagged across your repositories, with where it stands now." />
      {page.total === 0 && !filtered ? (
        <EmptyState icon="finding" title="No findings yet" actions={<ButtonLink href="/dashboard/reviews">See reviews</ButtonLink>}>
          <p>Published findings from reviews collect here, so you can track what was caught, fixed, or dismissed across every repository.</p>
        </EmptyState>
      ) : (
        <>
          <form className="filter-bar" action={PATH} aria-label="Filter findings" data-testid="findings-filters">
            <Select id="ff-repo" name="repo" label="Repository" value={state.repo ?? ""} any="All repositories" options={repos.map((r) => ({ value: String(r.id), label: r.fullName }))} />
            <Select id="ff-severity" name="severity" label="Severity" value={filter.severity?.[0] ?? ""} any="Any severity" options={SEVERITIES.map((s) => ({ value: s, label: humanize(s) }))} />
            <Select id="ff-category" name="category" label="Category" value={filter.category?.[0] ?? ""} any="Any category" options={facets.categories.map((c) => ({ value: c, label: humanize(c) }))} />
            <Select id="ff-status" name="status" label="Status" value={filter.status?.[0] ?? ""} any="Any status" options={STATUSES.map((s) => ({ value: s, label: humanize(s) }))} />
            <Select id="ff-author" name="author" label="PR author" value={filter.author ?? ""} any="Anyone" options={facets.authors.map((a) => ({ value: a, label: `@${a}` }))} />
            <Select id="ff-agent" name="agent" label="Agent" value={filter.agent ?? ""} any="Any agent" options={facets.agents.map((a) => ({ value: a, label: humanize(a) }))} />
            <div className="field">
              <label className="field-label" htmlFor="ff-from">
                From
              </label>
              <input id="ff-from" className="input" type="date" name="from" defaultValue={state.from ?? ""} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="ff-to">
                To
              </label>
              <input id="ff-to" className="input" type="date" name="to" defaultValue={state.to ?? ""} />
            </div>
            {state.sort && <input type="hidden" name="sort" value={state.sort} />}
            {state.dir && <input type="hidden" name="dir" value={state.dir} />}
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
            <FindingsTable findings={page.items} pathname={PATH} state={state} githubUrl={siteEnv().GITHUB_WEB_URL} />
          ) : (
            <EmptyState icon="filter" title="No findings match these filters" headingLevel={3} actions={<ButtonLink href={PATH}>Reset filters</ButtonLink>} />
          )}
          <Pagination pathname={PATH} state={state} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun="findings" />
        </>
      )}
    </>
  );
}
