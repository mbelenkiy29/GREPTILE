import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { inviteByEmail, revokeEmailInvitation } from "./actions";
import { emailOnWeb } from "../../src/email";

// People → invite by email: single-use links that expire in 7 days (needs email delivery).
export async function EmailInvitations({ token, organizationId, status }: { token: string; organizationId: Id<"organizations">; status?: string }) {
  const pending = await backend().query(api.identity.emailInvitations, { token, organizationId });
  const configured = emailOnWeb();
  return <section aria-labelledby="email-invite-heading">
    <h2 id="email-invite-heading">Invite by email</h2>
    {status === "sent" && <p role="status">Invitation sent.</p>}
    {status === "error" && <p role="alert">The invitation could not be sent. Check the address and email configuration.</p>}
    {!configured ? <p className="muted">Email delivery is not configured (RESEND_API_KEY and EMAIL_FROM on Convex, EMAIL_SIGN_IN=true on the web app). Invite by GitHub login instead.</p> : <form action={inviteByEmail} className="form-grid">
      <input type="hidden" name="organizationId" value={organizationId} />
      <label>Email<input type="email" name="email" required maxLength={254} /></label>
      <label>Role<select name="role" defaultValue="member"><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
      <button>Send invitation</button>
    </form>}
    {pending.length > 0 && <ul aria-label="Pending email invitations">{pending.map((i) => <li key={i._id}>{i.email} · {i.role} · expires {new Date(i.expiresAt).toLocaleDateString("en-US", { timeZone: "UTC" })}<form action={revokeEmailInvitation} className="inline-form"><input type="hidden" name="invitationId" value={i._id} /><button className="small">Revoke</button></form></li>)}</ul>}
  </section>;
}
