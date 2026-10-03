import { Avatar } from "@/components/auth/UserMenu";
import { formatDate } from "@/components/dashboard/format";
import { requireOrg } from "@/lib/auth";
import { can, canManageMember, ROLE_LABEL, ROLES, type Role } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listMembers, listOrgInvitations } from "@/lib/data/members";
import { ORG_ERROR_MESSAGES, orgErrorCode } from "@/lib/data/orgs";
import { changeRole, inviteMember, leaveCurrentOrg, removeFromOrg, revokeInvite } from "./actions";
import { InviteForm } from "./InviteForm";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table } from "@/components/ui/Table";

export const metadata = { title: "Team" };

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
    <>
      <PageHeader title="Team" description={`${members.length} member${members.length === 1 ? "" : "s"} in ${ctx.orgName}. Roles decide who can change repositories, rules, and settings.`} />
      {errorText && <Alert tone="error">{errorText}</Alert>}

      <Table caption="Members">
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
                      <form action={changeRole} className="inline-form">
                        <input type="hidden" name="userId" value={m.userId} />
                        <select name="role" className="select" style={{ width: "auto", minHeight: 30, padding: "3px 8px" }} defaultValue={m.role} aria-label={`Role for ${m.name}`}>
                          {options.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <SubmitButton size="sm">Save</SubmitButton>
                      </form>
                    ) : (
                      <Badge>{ROLE_LABEL[m.role]}</Badge>
                    )}
                  </td>
                  <td>{formatDate(m.joinedAt)}</td>
                  <td>
                    {removable && (
                      <form action={removeFromOrg} className="actions">
                        <input type="hidden" name="userId" value={m.userId} />
                        <SubmitButton size="sm" variant="danger">
                          Remove
                        </SubmitButton>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
      </Table>

      {canInvite && (
        <section className="stack-sm" aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite people</h2>
          <InviteForm action={inviteMember} />
          {invitations.length > 0 && (
            <Table caption="Pending invitations">
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
                      <td>
                        <form action={revokeInvite} className="actions">
                          <input type="hidden" name="invitationId" value={inv.id} />
                          <SubmitButton size="sm" variant="danger">
                            Revoke
                          </SubmitButton>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
            </Table>
          )}
        </section>
      )}

      <Card title={`Leave ${ctx.orgName}`} titleId="leave-heading">
        {ownWorkspace ? (
          <p className="dim">This is your personal workspace. It stays yours, so you can&apos;t leave it.</p>
        ) : lastOwner ? (
          <p className="dim">You&apos;re the only owner. Make someone else an owner before leaving.</p>
        ) : (
          <form action={leaveCurrentOrg} className="row">
            <span className="dim">You&apos;ll lose access until someone invites you again.</span>
            <SubmitButton variant="danger">Leave organization</SubmitButton>
          </form>
        )}
      </Card>
    </>
  );
}
