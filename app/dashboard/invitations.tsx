import type { Id } from "../../convex/_generated/dataModel";
import { InvitationForm } from "./invitation-form";

export function WorkspaceInvitations({invitations}:{invitations:{_id:Id<"invitations">;workspaceName:string;role:string;expiresAt:number}[]}) {
  if(!invitations.length)return null;
  return <section aria-label="Workspace invitations"><h2>Workspace invitations</h2>{invitations.map(i=><InvitationForm id={i._id} label={`Accept invitation to ${i.workspaceName}`} key={i._id}>
    <p><strong>{i.workspaceName}</strong> · {i.role} · Expires {new Date(i.expiresAt).toLocaleString("en-US",{timeZone:"UTC"})} UTC</p>
  </InvitationForm>)}</section>;
}
