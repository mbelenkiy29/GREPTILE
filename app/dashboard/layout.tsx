import { ClerkProvider, OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <div className="shell">
        <header className="topbar">
          <Link href="/dashboard" className="brand">
            Tracewise
          </Link>
          <nav className="nav" aria-label="Dashboard">
            <Link href="/dashboard/repos">Repositories</Link>
            <Link href="/dashboard/reviews">Reviews</Link>
          </nav>
          <div className="spacer" />
          <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/dashboard" />
          <UserButton />
        </header>
        <main>{children}</main>
      </div>
    </ClerkProvider>
  );
}
