import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { BarChart } from "@/components/ui/Chart";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat } from "@/components/ui/Stat";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { reviewActivity, usageThisMonth } from "@/lib/data/overview";
import { siteEnv } from "@/lib/env";
import { formatCount, formatUsd } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Usage" };

export default async function UsagePage() {
  const { orgId } = await requireOrg();
  const now = new Date();
  const [usage, activity] = await Promise.all([usageThisMonth(db(), orgId, now), reviewActivity(db(), orgId, { days: 30, now })]);
  const points = activity.map((d) => ({ label: d.day, value: d.runs }));
  const docs = `${siteEnv().SOURCE_CODE_URL}/blob/main/docs/OPENREVIEW_SPEC.md`;
  return (
    <>
      <PageHeader title="Usage" description={`Metered work this month (since ${usage.since.toISOString().slice(0, 10)}, UTC).`} />
      <div className="grid-kpi">
        <Stat label="Reviews" value={formatCount(usage.reviews)} />
        <Stat label="Input tokens" value={formatCount(usage.inputTokens)} />
        <Stat label="Output tokens" value={formatCount(usage.outputTokens)} />
        <Stat label="Estimated cost" value={formatUsd(usage.costUsd)} hint="Priced model calls only" />
        <Stat label="Credits" value={formatCount(usage.credits)} />
      </div>
      <Card title="Review runs" titleId="runs-heading" description="Per day, last 30 days (UTC)">
        <BarChart points={points} height={110} label="Review runs per day, last 30 days" unit="runs" />
      </Card>
      <EmptyState
        icon="usage"
        title="Per-repository and per-model breakdowns appear here"
        headingLevel={3}
        actions={
          <ButtonLink href={docs} external variant="ghost">
            How usage is metered
          </ButtonLink>
        }
      >
        <p>
          This page will break usage down by repository, model, and pull request author, with budgets and exports. The totals above already
          include every review, index, and chat call recorded this month.
        </p>
      </EmptyState>
    </>
  );
}
