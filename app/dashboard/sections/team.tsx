import { ScrollTable } from "../scroll-table";
import { invite, updateMember } from "../actions";
import { InvitationForm } from "../invitation-form";

import type { DashboardContext } from "../load";

export function TeamSection({ ctx }: { ctx: DashboardContext }) {
  const { data, isAdmin, organization, pendingInvitations } = ctx;
  return (
(
          <>
            {isAdmin && (
              <form action={invite} className="toolbar">
                <input
                  type="hidden"
                  name="organizationId"
                  value={organization._id}
                />
                <label>
                  GitHub login
                  <input name="login" required />
                </label>
                <label>
                  Role
                  <select name="role">
                    <option>member</option>
                    <option>viewer</option>
                    <option>admin</option>
                  </select>
                </label>
                <button className="primary">Invite member</button>
              </form>
            )}
            {isAdmin&&<section aria-label="Pending invitations"><h2>Pending invitations</h2>{pendingInvitations.length?<ScrollTable label="Pending invitations table"><table><thead><tr><th>GitHub login</th><th>Role</th><th>Expires</th><th>Action</th></tr></thead><tbody>{pendingInvitations.map(i=><tr key={i._id}><td>@{i.githubLogin}</td><td>{i.role}</td><td>{new Date(i.expiresAt).toLocaleString("en-US",{timeZone:"UTC"})} UTC</td><td><InvitationForm id={i._id} label={`Revoke invitation for ${i.githubLogin}`} revoke/></td></tr>)}</tbody></table></ScrollTable>:<p>No pending invitations.</p>}<p className="muted">Invitees see invitations when they sign in with their GitHub identity. Sending a new invitation replaces the previous invitation for that login in this workspace.</p></section>}
            <ScrollTable label="Workspace members table">
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m._id}>
                      <td>@{m.user?.login}</td>
                      <td>
                        {isAdmin ? (
                          <form action={updateMember}>
                            <input
                              type="hidden"
                              name="memberId"
                              value={m._id}
                            />
                            <select
                              name="role"
                              aria-label={`Role for ${m.user?.login}`}
                              defaultValue={m.role}
                            >
                              <option>member</option>
                              <option>viewer</option>
                              <option>admin</option>
                              {organization.role === "owner" && (
                                <option>owner</option>
                              )}
                            </select>
                            <button>Save role</button>
                            <button name="remove" value="true">
                              Remove member
                            </button>
                          </form>
                        ) : (
                          m.role
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          </>
        )
  );
}
