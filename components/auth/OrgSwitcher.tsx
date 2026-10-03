import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Icon } from "@/components/ui/icons";
import { menuItemProps } from "@/components/ui/menu";
import { ROLE_LABEL, type Role } from "@/lib/auth/permissions";

export interface SwitcherOrg {
  id: string;
  name: string;
  personal: boolean;
  role: Role;
}

/** Active org with a menu to switch to another of the user's orgs (each switch is a server action). */
export function OrgSwitcher({
  current,
  orgs,
  switchAction,
  align = "up",
}: {
  current: SwitcherOrg;
  orgs: SwitcherOrg[];
  switchAction: (formData: FormData) => Promise<void>;
  align?: "start" | "end" | "up";
}) {
  return (
    <DropdownMenu
      testId="org-switcher"
      align={align}
      label={`Organization: ${current.name}. Switch organization`}
      trigger={
        <span className="account-chip">
          <span className="org-initial" aria-hidden="true">
            {current.name.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <span className="truncate strong">{current.name}</span>
          <Badge tone="outline">{ROLE_LABEL[current.role]}</Badge>
          <Icon name="chevron-down" size={14} />
        </span>
      }
    >
      <div className="menu-label">Switch organization</div>
      {orgs.map((o) => (
        <form key={o.id} action={switchAction} role="none">
          <input type="hidden" name="orgId" value={o.id} />
          <button
            {...menuItemProps()}
            type="submit"
            disabled={o.id === current.id}
            aria-current={o.id === current.id ? "true" : undefined}
          >
            <span className="truncate">
              {o.name}
              {o.personal ? " (personal)" : ""}
            </span>
            <span className="dim">{ROLE_LABEL[o.role]}</span>
          </button>
        </form>
      ))}
      <div className="menu-sep" role="separator" />
      <Link {...menuItemProps()} href="/orgs">
        Create or join an organization
        <Icon name="plus" size={14} />
      </Link>
    </DropdownMenu>
  );
}
