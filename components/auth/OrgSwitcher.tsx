import Link from "next/link";
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
}: {
  current: SwitcherOrg;
  orgs: SwitcherOrg[];
  switchAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <details className="menu" data-testid="org-switcher">
      <summary aria-label={`Organization: ${current.name}. Switch organization`}>
        <span className="strong">{current.name}</span>
        <span className="badge badge-muted">{ROLE_LABEL[current.role]}</span>
      </summary>
      <div className="menu-panel">
        <div className="menu-label">Switch organization</div>
        {orgs.map((o) => (
          <form key={o.id} action={switchAction}>
            <input type="hidden" name="orgId" value={o.id} />
            <button className="menu-item" type="submit" disabled={o.id === current.id} aria-current={o.id === current.id ? "true" : undefined}>
              <span>
                {o.name}
                {o.personal ? " (personal)" : ""}
              </span>
              <span className="dim">{ROLE_LABEL[o.role]}</span>
            </button>
          </form>
        ))}
        <Link className="menu-item" href="/orgs">
          Create or join an organization
        </Link>
      </div>
    </details>
  );
}
