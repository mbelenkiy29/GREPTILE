import type { Metadata } from "next";
import { UsageView } from "@/components/usage/UsageView";
import { ButtonLink } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadUsagePage } from "@/lib/data/usage";
import { hrefWith, queryState, type SearchParams } from "@/lib/ui/url";

export const metadata: Metadata = { title: "Usage" };

/** Usage (R4.3): credits, tokens, and estimated model cost for a period, per day, repository, author, model, task, and kind. */
export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId } = await requireOrg();
  const sp = await searchParams;
  const data = await loadUsagePage(db(), orgId, sp);
  const state = queryState(sp);
  const exportState = { ...(state.period ? { period: state.period } : {}), ...(state.from ? { from: state.from } : {}), ...(state.to ? { to: state.to } : {}) };
  return (
    <>
      <PageHeader
        title="Usage"
        description="Metered work, tokens, and estimated model cost. Times are UTC."
        actions={
          <ButtonLink href="/dashboard/settings/usage" icon="settings" variant="ghost">
            Caps, alerts & billing
          </ButtonLink>
        }
      />
      <UsageView data={data} state={state} exportHref={hrefWith("/api/orgs/current/usage/export", exportState)} />
    </>
  );
}
