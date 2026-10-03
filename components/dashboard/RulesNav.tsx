import Link from "next/link";

/** Sub-navigation of the Rules section: written rules and conventions learned from feedback. */
export function RulesNav({ current }: { current: "rules" | "learned" }) {
  return (
    <nav className="tabs" aria-label="Rules sections">
      <Link href="/dashboard/rules" aria-current={current === "rules" ? "page" : undefined}>
        Rules
      </Link>
      <Link href="/dashboard/learned" aria-current={current === "learned" ? "page" : undefined}>
        Preferences
      </Link>
    </nav>
  );
}
