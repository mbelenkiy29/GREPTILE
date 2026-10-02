import Image from "next/image";
import Link from "next/link";

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
export function UserMenu({ user }: { user: UserMenuUser }) {
  return (
    <details className="menu" data-testid="user-menu">
      <summary aria-label={`Account menu for ${user.name}`}>
        <Avatar user={user} />
        <span>{user.name}</span>
      </summary>
      <div className="menu-panel">
        <div className="menu-label">{user.githubLogin ? `@${user.githubLogin}` : (user.email ?? "")}</div>
        <Link className="menu-item" href="/orgs">
          Organizations
        </Link>
        <form method="post" action="/api/auth/logout">
          <button className="menu-item" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
