import Link from "next/link";
import type { ReactNode } from "react";
import { OrgSwitcher } from "@/components/auth/OrgSwitcher";
import { UserMenu } from "@/components/auth/UserMenu";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listUserOrgs } from "@/lib/data/orgs";
import { switchOrg } from "../orgs/actions";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const ctx = await requireOrg();
  const orgs = await listUserOrgs(db(), ctx.userId);
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/dashboard" className="brand">
          OpenReview
        </Link>
        <nav className="nav" aria-label="Dashboard">
          <Link href="/dashboard/repos">Repositories</Link>
          <Link href="/dashboard/reviews">Reviews</Link>
          <Link href="/dashboard/rules">Rules</Link>
          <Link href="/dashboard/learned">Learned</Link>
          <Link href="/dashboard/team">Team</Link>
        </nav>
        <div className="spacer" />
        <OrgSwitcher
          current={{ id: ctx.orgId, name: ctx.orgName, personal: ctx.personal, role: ctx.role }}
          orgs={orgs}
          switchAction={switchOrg}
        />
        <UserMenu user={ctx.user} />
      </header>
      <main>{children}</main>
    </div>
  );
}
