import { cookies } from "next/headers";
import { Suspense, type ReactNode } from "react";
import { OrgSwitcher } from "@/components/auth/OrgSwitcher";
import { UserMenu } from "@/components/auth/UserMenu";
import { AppShell } from "@/components/shell/AppShell";
import { ShellFooter } from "@/components/shell/ShellFooter";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { Toaster } from "@/components/ui/Toast";
import { UsageBanners } from "@/components/usage/UsageBanners";
import { usageBanners, usageStatus } from "@/lib/billing/alerts";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listUserOrgs } from "@/lib/data/orgs";
import { siteEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/log";
import { parseTheme, THEME_COOKIE } from "@/lib/ui/theme";
import { APP_VERSION } from "@/lib/version";
import { switchOrg } from "../orgs/actions";

export const dynamic = "force-dynamic";

/** Usage alert banners across the dashboard (R4.3); a failure to compute them never breaks the page. */
async function OrgUsageBanners({ orgId }: { orgId: string }) {
  const banners = await usageStatus(db(), orgId).then(usageBanners, (err: unknown) => {
    log.warn("usage banners unavailable", { orgId, error: errorMessage(err) });
    return [];
  });
  return <UsageBanners banners={banners} />;
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const ctx = await requireOrg();
  const [orgs, cookieStore] = await Promise.all([listUserOrgs(db(), ctx.userId), cookies()]);
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  return (
    <AppShell
      account={
        <>
          <OrgSwitcher
            current={{ id: ctx.orgId, name: ctx.orgName, personal: ctx.personal, role: ctx.role }}
            orgs={orgs}
            switchAction={switchOrg}
          />
          <UserMenu user={ctx.user} />
        </>
      }
      tools={<ThemeToggle initial={theme} />}
      footer={<ShellFooter sourceUrl={siteEnv().SOURCE_CODE_URL} version={APP_VERSION} />}
    >
      <Suspense fallback={null}>
        <OrgUsageBanners orgId={ctx.orgId} />
      </Suspense>
      {children}
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
    </AppShell>
  );
}
