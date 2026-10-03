import Image from "next/image";
import Link from "next/link";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Icon } from "@/components/ui/icons";
import { menuItemProps } from "@/components/ui/menu";

export interface UserMenuUser {
  name: string;
  email: string | null;
  avatarUrl: string | null;
  githubLogin: string | null;
}

export function Avatar({ user, size = 24 }: { user: Pick<UserMenuUser, "avatarUrl">; size?: number }) {
  if (!user.avatarUrl) return <span className="avatar" style={{ width: size, height: size }} aria-hidden="true" />;
  // Avatars come from the identity provider's CDN (github.com or a GitHub Enterprise host); served as is.
  return <Image className="avatar" src={user.avatarUrl} alt="" width={size} height={size} unoptimized />;
}

/** Signed-in user: avatar, name, link to organizations, and sign out (a same-origin POST). */
export function UserMenu({ user, align = "up" }: { user: UserMenuUser; align?: "start" | "end" | "up" }) {
  return (
    <DropdownMenu
      testId="user-menu"
      align={align}
      label={`Account menu for ${user.name}`}
      trigger={
        <span className="account-chip">
          <Avatar user={user} />
          <span className="truncate">{user.name}</span>
          <Icon name="chevron-down" size={14} />
        </span>
      }
    >
      <div className="menu-label">{user.githubLogin ? `@${user.githubLogin}` : (user.email ?? "")}</div>
      <Link {...menuItemProps()} href="/orgs">
        Organizations
        <Icon name="building" size={14} />
      </Link>
      <div className="menu-sep" role="separator" />
      <form method="post" action="/api/auth/logout" role="none">
        <button {...menuItemProps()} type="submit">
          Sign out
          <Icon name="logout" size={14} />
        </button>
      </form>
    </DropdownMenu>
  );
}
