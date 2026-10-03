import { Avatar } from "@/components/auth/UserMenu";
import { formatDate } from "@/components/dashboard/format";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { can, canManageMember, ROLE_DESCRIPTION, ROLE_LABEL, ROLES, type Role } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listMembers, listOrgInvitations } from "@/lib/data/members";
import { ORG_ERROR_MESSAGES, orgErrorCode } from "@/lib/data/orgs";
import { formatRelative } from "@/lib/ui/format";
import { param, type SearchParams } from "@/lib/ui/url";
import { changeRole, inviteMember, leaveCurrentOrg, newInviteLink, removeFromOrg, revokeInvite } from "./actions";
import { InviteForm } from "./InviteForm";
import { InviteLinkButton } from "./InviteLinkButton";

export const metadata = { title: "Team" };

/** Roles `actor` may move a member with role `from` to (always including the current role). */
function roleOptions(actor: Role, from: Role): Role[] {
  return ROLES.filter((r) => r === from || canManageMember(actor, from, r));
}

export default async function TeamPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const query = param(sp, "q")?.trim().slice(0, 100) ?? "";
  const canInvite = can(ctx.role, "members.invite");
  const now = new Date();
  const [members, everyone, invitations] = await Promise.all([
    listMembers(db(), ctx.orgId, { query }),
    query ? listMembers(db(), ctx.orgId) : Promise.resolve(null),
    canInvite ? listOrgInvitations(db(), ctx.orgId, now) : Promise.resolve([]),
  ]);
  const all = everyone ?? members;
  const errorCode = orgErrorCode(param(sp, "error"));
  const errorText = errorCode ? ORG_ERROR_MESSAGES[errorCode] : null;
  const owners = all.filter((m) => m.role === "owner").length;
  const lastOwner = ctx.role === "owner" && owners <= 1;
  const ownWorkspace = all.some((m) => m.userId === ctx.userId && m.workspaceCreator);

  return (
    <>
      <PageHeader title="Team" description={`${all.length} member${all.length === 1 ? "" : "s"} in ${ctx.orgName}. Roles decide who can change repositories, rules, and settings.`} />
      {errorText && <Alert tone="error">{errorText}</Alert>}

      <form className="filter-bar" action="/dashboard/team" role="search" aria-label="Search members">
        <div className="field" style={{ flex: "1 1 240px" }}>
          <label className="field-label" htmlFor="member-q">
            Search members
          </label>
          <input id="member-q" className="input" type="search" name="q" defaultValue={query} placeholder="Name, GitHub username, or email" />
        </div>
        <div className="filter-bar-actions">
          <button className="button" type="submit">
            Search
          </button>
          {query && (
            <ButtonLink href="/dashboard/team" variant="ghost">
              Clear
            </ButtonLink>
          )}
        </div>
      </form>

      {members.length === 0 ? (
        <p className="empty">No members match “{query}”.</p>
      ) : (
        <Table caption="Members">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Last active</th>
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
                  <td className="nowrap">{m.lastActiveAt ? formatRelative(m.lastActiveAt, now) : <span className="dim">Never</span>}</td>
                  <td className="nowrap">{formatDate(m.joinedAt)}</td>
                  <td>
                    {removable && (
                      <form action={removeFromOrg} className="actions">
                        <input type="hidden" name="userId" value={m.userId} />
                        <ConfirmButton prompt={`Remove ${m.name}?`} confirmLabel="Remove">
                          Remove
                        </ConfirmButton>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <Card title="Roles" titleId="roles-heading">
        <dl className="kv">
          {ROLES.map((r) => (
            <div key={r} style={{ display: "contents" }}>
              <dt>{ROLE_LABEL[r]}</dt>
              <dd>{ROLE_DESCRIPTION[r]}</dd>
            </div>
          ))}
        </dl>
      </Card>

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
                  <th scope="col">Link</th>
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
                    <td className="nowrap">{formatDate(inv.expiresAt)}</td>
                    <td>
                      <InviteLinkButton invitationId={inv.id} action={newInviteLink} />
                    </td>
                    <td>
                      <form action={revokeInvite} className="actions">
                        <input type="hidden" name="invitationId" value={inv.id} />
                        <ConfirmButton prompt="Revoke this invitation?" confirmLabel="Revoke">
                          Revoke
                        </ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {invitations.length > 0 && <p className="dim">Invitation links are shown only once. “New link” replaces an invitation&apos;s link and restarts its 7-day expiry.</p>}
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
