import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/dashboard/SettingsTabs";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOrg } from "@/lib/auth";

/** Settings (R6.14): a tab per section; sections are separate routes (see components/dashboard/settings-tabs.ts). */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { orgName } = await requireOrg();
  return (
    <>
      <PageHeader title="Settings" description={`Organization-wide settings for ${orgName}.`} />
      <SettingsTabs />
      <div className="stack">{children}</div>
    </>
  );
}
