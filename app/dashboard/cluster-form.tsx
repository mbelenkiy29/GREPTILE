"use client";
import {repositoryDisplay} from "../../src/provider-display";
import type {ProviderDisplayIdentity} from "../../src/provider-display";
import {startTransition,useActionState,useState} from "react";
import type {Id} from "../../convex/_generated/dataModel";
import {saveClusterForm} from "./actions";

type Repository={_id:Id<"repositories">;fullName:string;provider:ProviderDisplayIdentity|null;indexedSha?:string;indexStatus:string;enabled:boolean};
export function ClusterForm({organizationId,repositories,cluster}:{organizationId:Id<"organizations">;repositories:Repository[];cluster?:{_id:Id<"repositoryClusters">;name:string;repositoryIds:Id<"repositories">[]}}){
 const [name,setName]=useState(cluster?.name??""),[selected,setSelected]=useState(cluster?.repositoryIds??[] as Id<"repositories">[]);
 const [state,action,pending]=useActionState(async(previous:{error?:string;saved?:boolean},form:FormData)=>{
  const result=await saveClusterForm(previous,form);
  if(result.saved&&!cluster){setName("");setSelected([]);}
  return result;
 },{});
 return <form onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);startTransition(()=>action(form));}} className="form-grid cluster-form" style={{gridTemplateColumns:"1fr"}} key={JSON.stringify(cluster)}>
  <input type="hidden" name="organizationId" value={organizationId}/>{cluster&&<input type="hidden" name="id" value={cluster._id}/>}
  <label>Name<input name="name" required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
  <fieldset><legend>Select 2–20 repositories</legend>{repositories.map(r=><div key={r._id}>
   <label className="check repository-choice"><input type="checkbox" name="repositoryIds" value={r._id} checked={selected.includes(r._id)} onChange={e=>setSelected(e.target.checked?[...selected,r._id]:selected.filter(id=>id!==r._id))}/><span>{repositoryDisplay(r)}</span></label>
   <details><summary className="repository-identity">Indexing details · {repositoryDisplay(r)}</summary><p>Status: {r.indexStatus} · {r.enabled?"Reviews enabled":"Reviews disabled"}</p><p>Current indexed revision: <code>{r.indexedSha??"Not indexed"}</code></p></details>
  </div>)}</fieldset>
  <p className="muted">Reviews record the exact source revisions fetched. A selected repository may be omitted if indexing or current author access is unavailable.</p>
  <button disabled={pending}>{pending?"Saving…":cluster?"Save cluster":"Create cluster"}</button>
  {state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Cluster saved.</p>}
 </form>;
}
