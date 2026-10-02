import { Avatar } from "@/components/auth/UserMenu";
import { formatDate } from "@/components/dashboard/format";
import { requireOrg } from "@/lib/auth";
import { can, canManageMember, ROLE_LABEL, ROLES, type Role } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listMembers, listOrgInvitations } from "@/lib/data/members";
import { ORG_ERROR_MESSAGES, orgErrorCode } from "@/lib/data/orgs";
import { changeRole, inviteMember, leaveCurrentOrg, removeFromOrg, revokeInvite } from "./actions";
import { InviteForm } from "./InviteForm";

export const metadata = { title: "Team · OpenReview" };

/** Roles `actor` may move a member with role `from` to (always including the current role). */
function roleOptions(actor: Role, from: Role): Role[] {
  return ROLES.filter((r) => r === from || canManageMember(actor, from, r));
}

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const ctx = await requireOrg();
  const canInvite = can(ctx.role, "members.invite");
  const [members, invitations] = await Promise.all([
    listMembers(db(), ctx.orgId),
    canInvite ? listOrgInvitations(db(), ctx.orgId, new Date()) : Promise.resolve([]),
  ]);
  const { error } = await searchParams;
  const errorCode = orgErrorCode(error);
  const errorText = errorCode ? ORG_ERROR_MESSAGES[errorCode] : null;
  const owners = members.filter((m) => m.role === "owner").length;
  const lastOwner = ctx.role === "owner" && owners <= 1;
  const ownWorkspace = members.some((m) => m.userId === ctx.userId && m.workspaceCreator);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Team</h1>
        <span className="dim">
          {members.length} member{members.length === 1 ? "" : "s"} in {ctx.orgName}
        </span>
      </div>
      {errorText && (
        <p className="notice notice-bad" role="alert">
          {errorText}
        </p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Joined</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              // A personal workspace's creator always stays its owner.
              const managed = m.userId !== ctx.userId && !m.workspaceCreator;
              const options = managed ? roleOptions(ctx.role, m.role) : [];
              const removable = managed && canManageMember(ctx.role, m.role, null);
              return (
                <tr key={m.userId} data-member={m.githubLogin ?? m.email ?? m.userId}>
                  <td>
                    <div className="row">
                      <Avatar user={m} />
                      <div>
                        <div className="strong">
                          {m.name}
                          {m.userId === ctx.userId ? " (you)" : ""}
                        </div>
                        <div className="dim">
                          {m.githubLogin ? `@${m.githubLogin}` : m.email}
                          {m.workspaceCreator ? " · personal workspace creator" : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {options.length > 1 ? (
                      <form action={changeRole} className="row">
                        <input type="hidden" name="userId" value={m.userId} />
                        <select name="role" defaultValue={m.role} aria-label={`Role for ${m.name}`}>
                          {options.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <button className="button" type="submit">
                          Save
                        </button>
                      </form>
                    ) : (
                      <span className="badge badge-muted">{ROLE_LABEL[m.role]}</span>
                    )}
                  </td>
                  <td>{formatDate(m.joinedAt)}</td>
                  <td className="actions">
                    {removable && (
                      <form action={removeFromOrg}>
                        <input type="hidden" name="userId" value={m.userId} />
                        <button className="button" type="submit">
                          Remove
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canInvite && (
        <section className="stack-sm" aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite people</h2>
          <InviteForm action={inviteMember} />
          {invitations.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Pending invitation</th>
                    <th scope="col">Role</th>
                    <th scope="col">Invited by</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((inv) => (
                    <tr key={inv.id} data-invitation={inv.id}>
                      <td>{inv.githubLogin ? `@${inv.githubLogin}` : (inv.email ?? <span className="dim">Anyone with the link</span>)}</td>
                      <td>{ROLE_LABEL[inv.role]}</td>
                      <td>{inv.invitedByName ?? "—"}</td>
                      <td>{formatDate(inv.expiresAt)}</td>
                      <td className="actions">
                        <form action={revokeInvite}>
                          <input type="hidden" name="invitationId" value={inv.id} />
                          <button className="button" type="submit">
                            Revoke
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="stack-sm" aria-labelledby="leave-heading">
        <h2 id="leave-heading">Leave {ctx.orgName}</h2>
        {ownWorkspace ? (
          <p className="dim">This is your personal workspace. It stays yours, so you can&apos;t leave it.</p>
        ) : lastOwner ? (
          <p className="dim">You&apos;re the only owner. Make someone else an owner before leaving.</p>
        ) : (
          <form action={leaveCurrentOrg} className="row">
            <span className="dim">You&apos;ll lose access until someone invites you again.</span>
            <button className="button" type="submit">
              Leave organization
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
