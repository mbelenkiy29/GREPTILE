"use client";
import {useActionState} from "react";
import Link from "next/link";
import {selectOnboardingRepositories,startOnboardingIndexing} from "./actions";
import {providerDisplay,type ProviderDisplayIdentity} from "../../src/provider-display";
export function OnboardingSelection({organizationId,repositories,admin}:{organizationId:string;repositories:{_id:string;fullName:string;defaultBranch:string;selected:boolean;setupError:string|null;nativeIndex?:boolean;provider:ProviderDisplayIdentity|null}[];admin:boolean}){
 const [state,action,pending]=useActionState(selectOnboardingRepositories,{});
 if(!repositories.length)return <p>No repositories are available in this workspace. <Link href="/dashboard/settings/providers">Select repositories from your connected provider</Link>. A workspace admin can update provider access.</p>;
 return <form action={action} className="onboarding-selection"><input type="hidden" name="organizationId" value={organizationId}/>{repositories.map(r=><div key={r._id}><label className="check"><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={r.selected} disabled={!admin||!!r.setupError}/><span>{r.fullName} · {r.nativeIndex?"Native Perforce project":r.defaultBranch||"No default branch"}<small className="onboarding-provider muted">{providerDisplay(r.provider)}</small></span></label>{r.setupError&&<p role="status">{r.setupError}</p>}</div>)}<button disabled={!admin||pending}>{pending?"Saving…":"Save repository selection"}</button>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Repository selection saved.</p>}</form>;
}
export function StartOnboardingIndexing({organizationId,admin}:{organizationId:string;admin:boolean}){
 const [state,action,pending]=useActionState(startOnboardingIndexing,{});
 return <form action={action}><input type="hidden" name="organizationId" value={organizationId}/><button disabled={!admin||pending}>{pending?"Starting…":"Enable selected repositories and start indexing"}</button>{state.error&&<p role="alert">{state.error}</p>}</form>;
}
