import type { IconName } from "@/components/ui/icons";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Other path prefixes that belong to this section (e.g. Learned lives under Rules). */
  also?: string[];
}

/** Dashboard sections (R6.13), in sidebar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", label: "Overview", href: "/dashboard", icon: "overview" },
  { id: "repos", label: "Repositories", href: "/dashboard/repos", icon: "repo" },
  { id: "reviews", label: "Reviews", href: "/dashboard/reviews", icon: "review" },
  { id: "findings", label: "Findings", href: "/dashboard/findings", icon: "finding" },
  { id: "knowledge", label: "Knowledge", href: "/dashboard/knowledge", icon: "knowledge" },
  { id: "rules", label: "Rules", href: "/dashboard/rules", icon: "rules", also: ["/dashboard/learned"] },
  { id: "team", label: "Team", href: "/dashboard/team", icon: "team" },
  { id: "usage", label: "Usage", href: "/dashboard/usage", icon: "usage" },
  { id: "settings", label: "Settings", href: "/dashboard/settings", icon: "settings" },
  { id: "activity", label: "Activity", href: "/dashboard/activity", icon: "activity" },
];

function under(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The nav item a path belongs to (Overview only for `/dashboard` itself). */
export function activeNavId(pathname: string): string | null {
  const path = pathname.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  if (path === "/dashboard") return "overview";
  for (const item of NAV_ITEMS) {
    if (item.id === "overview") continue;
    if (under(path, item.href) || item.also?.some((p) => under(path, p))) return item.id;
  }
  return null;
}
