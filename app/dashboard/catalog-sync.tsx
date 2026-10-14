"use client";
import {useActionState} from 'react';import {syncPullCatalog,requestCatalogReview} from './actions';
export function CatalogSync({repositoryId,disabled}:{repositoryId:string;disabled?:boolean}){
 const [state,action,pending]=useActionState(syncPullCatalog,{});
 return <form action={action}><input type="hidden" name="repositoryId" value={repositoryId}/><button disabled={disabled||pending}>{pending?'Starting import…':'Sync open pull requests'}</button>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Import requested. Progress updates automatically.</p>}</form>;
}

export function CatalogReview({repositoryId,prNumber,revision,baseRevision}:{repositoryId:string;prNumber:number;revision:string;baseRevision:string}){
 const [state,action,pending]=useActionState(requestCatalogReview,{});
 return <form className="catalog-review" action={action}><input type="hidden" name="repositoryId" value={repositoryId}/><input type="hidden" name="prNumber" value={prNumber}/><input type="hidden" name="expectedRevision" value={revision}/><input type="hidden" name="expectedBaseRevision" value={baseRevision}/><button aria-label={'Review current revision for #'+prNumber} disabled={pending}>{pending?'Starting review…':'Review current revision'}</button>{state.error&&<p role="alert">{state.error}</p>}</form>;
}
