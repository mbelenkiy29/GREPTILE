import type { Metadata } from "next";
import { InstallationHealth } from "@/components/dashboard/InstallationHealth";
import { OverviewEmpty, OverviewView } from "@/components/dashboard/Overview";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { getOverview } from "@/lib/data/overview";
import { unhealthyInstallations } from "@/lib/data/repos";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const { orgId, orgName, role } = await requireOrg();
  const [overview, unhealthy] = await Promise.all([getOverview(db(), orgId), unhealthyInstallations(db(), orgId)]);
  const indexing = overview.indexing.some((r) => r.job !== null);
  return (
    <>
      <PageHeader title="Overview" description={`How reviews are going across ${orgName}.`} />
      <InstallationHealth installations={unhealthy} />
      <AutoRefresh active={indexing} intervalMs={8000} />
      {overview.counts.repos === 0 ? <OverviewEmpty canInstall={can(role, "repos.manage")} /> : <OverviewView overview={overview} />}
    </>
  );
}
