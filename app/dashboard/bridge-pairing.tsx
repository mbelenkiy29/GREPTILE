"use client";

import {useActionState,useState} from "react";
import type {Id} from "../../convex/_generated/dataModel";
import {reviewBridgePair} from "./actions";

export function BridgePairing({organizationId}:{organizationId:Id<"organizations">}){
 const [code,setCode]=useState("");
 const [state,action,pending]=useActionState(reviewBridgePair,{});
 const normalized=code.trim().replaceAll("-","").toLowerCase(),current=state.code===normalized,preview=current?state.preview:undefined;
 return <div className="bridge-pairing">
  <form action={action}><input type="hidden" name="organizationId" value={organizationId}/><label>Pairing code<input name="code" required pattern="[a-fA-F0-9-]{12,14}" placeholder="Code printed by your bridge" autoComplete="off" value={code} onChange={e=>setCode(e.target.value)}/></label><button disabled={pending}>{pending?"Checking pairing…":"Review bridge pairing"}</button></form>
  {preview&&<section aria-label="Review bridge pairing"><h3>{preview.name}</h3><p>Account: @{preview.account} · Workspace: {preview.workspace}</p><p>This bridge can claim fixes you explicitly request in this workspace and launch your selected local agent in registered checkouts. Access lasts 90 days and can be revoked in Paired devices.</p><p className="muted">Confirm this device name and code match your local bridge. Pairing code expires {new Date(preview.expiresAt).toLocaleString()}.</p><form action={action}><input type="hidden" name="organizationId" value={preview.organizationId}/><input type="hidden" name="userId" value={preview.userId}/><input type="hidden" name="code" value={normalized}/><input type="hidden" name="deviceId" value={preview.deviceId}/><button disabled={pending}>{pending?"Approving pairing…":"Approve bridge pairing"}</button></form></section>}
  {current&&state.error&&<p role="alert">{state.error}</p>}{current&&state.saved&&<p role="status">Bridge paired. Register your checkout and run bridge status.</p>}
 </div>;
}
