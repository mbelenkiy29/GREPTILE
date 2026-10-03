import { cookies } from "next/headers";
import { Suspense, type ReactNode } from "react";
import { OrgSwitcher } from "@/components/auth/OrgSwitcher";
import { UserMenu } from "@/components/auth/UserMenu";
import { AppShell } from "@/components/shell/AppShell";
import { ShellFooter } from "@/components/shell/ShellFooter";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { Toaster } from "@/components/ui/Toast";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listUserOrgs } from "@/lib/data/orgs";
import { siteEnv } from "@/lib/env";
import { parseTheme, THEME_COOKIE } from "@/lib/ui/theme";
import { APP_VERSION } from "@/lib/version";
import { switchOrg } from "../orgs/actions";

export const dynamic = "force-dynamic";

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
      {children}
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
    </AppShell>
  );
}
