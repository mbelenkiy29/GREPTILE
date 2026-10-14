"use client";
import {repositoryDisplay} from "../../src/provider-display";
import {useState,useActionState} from "react";
import {approvalDefaults} from "../../src/review-settings";
import {saveApprovalPolicy} from "./actions";
type Policy=typeof approvalDefaults;
export function ApprovalPolicyForm({organizationId,policies,teams,repositories}:{organizationId:string;policies:{teamId?:string;repositoryId?:string;policy:Policy}[];teams:{_id:string;name:string}[];repositories:{_id:string;fullName:string;teamId?:string}[]}){
 const [scope,setScope]=useState("organization"),[state,action,pending]=useActionState(saveApprovalPolicy,{});
 const repositoryId=scope.startsWith("repository:")?scope.slice(11):undefined,teamId=scope.startsWith("team:")?scope.slice(5):undefined,repo=repositories.find(r=>r._id===repositoryId);
 const own=policies.find(p=>p.repositoryId===repositoryId&&p.teamId===teamId);
 const parent=policies.find(p=>!p.repositoryId&&p.teamId===repo?.teamId&&p.teamId)?.policy??policies.find(p=>!p.repositoryId&&!p.teamId)?.policy??approvalDefaults;
 const value=own?.policy??parent;
 return <form className="form-grid policy-form" action={action}>
  <input name="organizationId" type="hidden" value={organizationId}/>
  <label>Approval scope<select name="scope" value={scope} onChange={e=>setScope(e.target.value)}><option value="organization">Organization defaults</option>{teams.map(t=><option key={t._id} value={"team:"+t._id}>{t.name} · team</option>)}{repositories.map(r=><option key={r._id} value={"repository:"+r._id}>{repositoryDisplay(r)} · repository</option>)}</select></label>
  <fieldset key={scope}><legend>{own?"Explicit policy":"Inherited policy"}</legend>
   <label className="check"><input name="enabled" type="checkbox" defaultChecked={value.enabled}/>Automatically approve eligible revisions</label>
   <label>Maximum risk<select name="maximumRisk" defaultValue={value.maximumRisk}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
   <label>Excluded file globs, one per line<textarea name="excludedPaths" defaultValue={value.excludedPaths.join("\n")} maxLength={30000}/></label>
   <label>Excluded authors, one per line<textarea name="excludedAuthors" defaultValue={value.excludedAuthors.join("\n")} maxLength={10000}/></label>
   <label>Additional required checks, one per line<textarea name="requiredChecks" placeholder="regression | 12345" defaultValue={value.requiredChecks.map(c=>c.name+(c.appId?" | "+c.appId:"")).join("\n")} maxLength={22000}/></label>
   <p className="muted">Use a check name and optional GitHub App ID separated by |. Native provider requirements are always checked. Approval adapters support GitHub Cloud/Enterprise, GitLab, Gitea, Cursor Origin and Bitbucket Cloud/Data Center; each connection requires its native approval permissions. Missing permissions or unsupported provider rules block approval.</p>
   <p>Enabling this policy authorizes OpenReview to publish approvals after a complete current-revision review, maximum confidence, zero unresolved findings, passing required checks, and no human change request. New revisions and policy changes invalidate prior approvals. OpenReview never merges.</p>
   <button disabled={pending}>{pending?"Saving…":"Save approval policy"}</button>{scope!=="organization"&&<button name="inherit" value="true" disabled={pending}>Sync from parent</button>}
  </fieldset>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Approval policy saved.</p>}
 </form>;
}
