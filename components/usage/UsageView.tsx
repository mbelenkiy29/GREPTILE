import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { BarChart } from "@/components/ui/Chart";
import { Pagination } from "@/components/ui/Pagination";
import { Stat } from "@/components/ui/Stat";
import { Table } from "@/components/ui/Table";
import type { Page } from "@/lib/data/paginate";
import { PERIOD_LABEL, PERIOD_PRESETS, type UsageBreakdownRow, type UsageDay, type UsageRange, type UsageSummary } from "@/lib/data/usage";
import { formatCount, formatDuration, formatUsd } from "@/lib/ui/format";
import type { QueryState } from "@/lib/ui/url";

export const USAGE_PATH = "/dashboard/usage";

export interface UsageViewData {
  range: UsageRange;
  summary: UsageSummary;
  daily: UsageDay[];
  byRepo: Page<UsageBreakdownRow>;
  byAuthor: Page<UsageBreakdownRow>;
  byModel: Page<UsageBreakdownRow>;
  byTask: Page<UsageBreakdownRow>;
  byKind: UsageBreakdownRow[];
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function PeriodForm({ range }: { range: UsageRange }) {
  const lastDay = isoDay(new Date(range.end.getTime() - DAY_MS));
  return (
    <form className="filter-bar" action={USAGE_PATH} aria-label="Usage period" data-testid="usage-period">
      <div className="field">
        <label className="field-label" htmlFor="up-period">
          Period
        </label>
        <select id="up-period" name="period" className="select" defaultValue={range.preset}>
          {PERIOD_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="up-from">
          From (custom)
        </label>
        <input id="up-from" className="input" type="date" name="from" defaultValue={isoDay(range.start)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="up-to">
          To (custom)
        </label>
        <input id="up-to" className="input" type="date" name="to" defaultValue={lastDay} />
      </div>
      <div className="filter-bar-actions">
        <button className="button" type="submit">
          Apply
        </button>
      </div>
    </form>
  );
}

type Column = "reviews" | "credits" | "calls" | "inputTokens" | "outputTokens" | "costUsd";
const HEAD: Record<Column, string> = {
  reviews: "Reviews",
  credits: "Credits",
  calls: "Model calls",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  costUsd: "Est. cost",
};

function cell(row: UsageBreakdownRow, c: Column): string {
  if (c === "costUsd") return formatUsd(row.costUsd);
  return formatCount(row[c] ?? 0);
}

function Breakdown({
  title,
  id,
  keyLabel,
  columns,
  rows,
  page,
  param,
  state,
  noun,
  empty,
}: {
  title: string;
  id: string;
  keyLabel: string;
  columns: Column[];
  rows: UsageBreakdownRow[];
  page?: Page<UsageBreakdownRow>;
  param?: string;
  state: QueryState;
  noun: string;
  empty: string;
}) {
  return (
    <Card title={title} titleId={id} flush>
      {rows.length ? (
        <>
          <Table caption={title} compact>
            <thead>
              <tr>
                <th scope="col">{keyLabel}</th>
                {columns.map((c) => (
                  <th key={c} scope="col" className="num">
                    {HEAD[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-usage-row={`${id}:${r.key}`}>
                  <td className="strong">{r.key}</td>
                  {columns.map((c) => (
                    <td key={c} className="num">
                      {cell(r, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
          {page && param && page.pageCount > 1 && (
            <div className="card-foot">
              <Pagination pathname={USAGE_PATH} state={state} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun={noun} param={param} label={`${title} pages`} />
            </div>
          )}
        </>
      ) : (
        <p className="card-body dim">{empty}</p>
      )}
    </Card>
  );
}

/** The usage page body (R4.3): period selector, KPIs, daily charts, breakdowns, and the CSV export link. */
export function UsageView({ data, state, exportHref }: { data: UsageViewData; state: QueryState; exportHref: string }) {
  const { summary: s, daily, range } = data;
  const label = `${PERIOD_LABEL[range.preset]} (${range.label}, UTC)`;
  const eventColumns: Column[] = ["reviews", "credits", "inputTokens", "outputTokens", "costUsd"];
  const callColumns: Column[] = ["calls", "inputTokens", "outputTokens", "costUsd"];
  return (
    <div className="stack" data-usage-range={`${isoDay(range.start)}..${isoDay(range.end)}`}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <PeriodForm range={range} />
        <ButtonLink href={exportHref} icon="arrow-down" variant="ghost">
          Export CSV
        </ButtonLink>
      </div>
      <p className="dim">{label}</p>
      <div className="grid-kpi">
        <Stat label="Reviews" value={formatCount(s.reviews)} hint="Completed in the period" />
        <Stat label="Credits" value={formatCount(s.credits)} />
        <Stat label="Input tokens" value={formatCount(s.inputTokens)} />
        <Stat label="Output tokens" value={formatCount(s.outputTokens)} />
        <Stat label="Estimated model cost" value={formatUsd(s.modelCostUsd)} hint={s.unpricedCalls ? `${formatCount(s.unpricedCalls)} unpriced calls not included` : "All model calls"} />
        <Stat label="Indexing cost" value={formatUsd(s.indexingCostUsd)} hint="Embeddings" />
        <Stat label="Knowledge & chat cost" value={formatUsd(s.otherCostUsd)} hint="And other background work" />
        <Stat label="Average review cost" value={formatUsd(s.avgReviewCostUsd)} />
        <Stat label="Average review duration" value={s.avgReviewDurationMs === null ? "—" : formatDuration(s.avgReviewDurationMs)} />
        <Stat label="Active developers" value={formatCount(s.activeDevelopers)} hint="PR authors reviewed" />
      </div>
      <div className="grid-2">
        <Card title="Reviews per day" titleId="usage-reviews-chart">
          <BarChart points={daily.map((d) => ({ label: d.day, value: d.reviews }))} height={110} label="Reviews per day" unit="reviews" />
        </Card>
        <Card title="Credits per day" titleId="usage-credits-chart">
          <BarChart points={daily.map((d) => ({ label: d.day, value: d.credits }))} height={110} label="Credits per day" unit="credits" />
        </Card>
      </div>
      <Card title="Estimated model cost per day (USD)" titleId="usage-cost-chart">
        <BarChart points={daily.map((d) => ({ label: d.day, value: Math.round(d.costUsd * 100) / 100 }))} height={110} label="Estimated model cost per day" unit="USD" />
      </Card>
      <Breakdown title="By repository" id="usage-by-repo" keyLabel="Repository" columns={eventColumns} rows={data.byRepo.items} page={data.byRepo} param="repoPage" state={state} noun="repositories" empty="No usage in this period." />
      <Breakdown title="By pull request author" id="usage-by-author" keyLabel="Author" columns={eventColumns} rows={data.byAuthor.items} page={data.byAuthor} param="authorPage" state={state} noun="authors" empty="No pull request authors in this period." />
      <div className="grid-2">
        <Breakdown title="By model" id="usage-by-model" keyLabel="Model" columns={callColumns} rows={data.byModel.items} page={data.byModel} param="modelPage" state={state} noun="models" empty="No model calls in this period." />
        <Breakdown title="By task" id="usage-by-task" keyLabel="Task" columns={callColumns} rows={data.byTask.items} page={data.byTask} param="taskPage" state={state} noun="tasks" empty="No model calls in this period." />
      </div>
      <Breakdown title="By kind of work" id="usage-by-kind" keyLabel="Kind" columns={eventColumns} rows={data.byKind} state={state} noun="kinds" empty="No metered work in this period." />
    </div>
  );
}
