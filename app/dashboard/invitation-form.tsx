"use client";
import {useActionState} from "react";
import type {ReactNode} from "react";
import type {Id} from "../../convex/_generated/dataModel";
import {acceptInvitation,revokeInvitation} from "./actions";

export function InvitationForm({id,label,revoke=false,children}:{id:Id<"invitations">;label:string;revoke?:boolean;children?:ReactNode}) {
 const [state,action,pending]=useActionState(revoke?revokeInvitation:acceptInvitation,{});
 return <form action={action} className="toolbar">
  <input type="hidden" name="invitationId" value={id}/>{children}
  <button disabled={pending}>{pending?(revoke?"Revoking…":"Joining…"):label}</button>
  {state.error&&<p role="alert">{state.error}</p>}
 </form>;
}
