"use client";
import {useActionState} from 'react';
import {connectP4Identity,revokeP4Identity} from './actions';
import type {Id} from '../../convex/_generated/dataModel';
type Entry={repositoryId:Id<'repositories'>;name:string;instance:string;canLink:boolean;identity:{id:Id<'p4Identities'>;username:string;active:boolean;expiresAt:number}|null};
function Identity({entry,asOf}:{entry:Entry;asOf:number}){
 const [state,action,pending]=useActionState(connectP4Identity,{});
 return <div className="panel"><h3>{entry.name}</h3><p className="muted">{entry.instance}</p>{entry.identity&&<div className="stat-row"><p>{entry.identity.username} · {entry.identity.active?(entry.identity.expiresAt>asOf?`Linked until ${new Date(entry.identity.expiresAt).toLocaleString("en-US",{timeZone:"UTC"})+" UTC"}`:'Expired'):'Disconnected'}</p>{entry.identity.active&&<form action={revokeP4Identity}><input type="hidden" name="identityId" value={entry.identity.id}/><button>Disconnect native identity</button></form>}</div>}{entry.canLink?<form action={action}><input type="hidden" name="repositoryId" value={entry.repositoryId}/><label>P4 username<input name="username" required autoComplete="username" maxLength={200}/></label><label>Existing P4 login ticket<input name="ticket" type="password" required autoComplete="off" minLength={10} maxLength={10000}/></label><p className="muted">Use your own existing P4 ticket. OpenReview authenticates it against this project, stores it encrypted, and expires this link after 24 hours. Your native ticket may expire sooner. Disconnect removes the saved credential.</p><button disabled={pending}>{pending?'Checking native identity…':'Link native identity'}</button>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Native identity linked.</p>}</form>:<p>Workspace and team viewers cannot link a native identity.</p>}</div>;
}
export function P4Identities({entries,asOf}:{entries:Entry[];asOf:number}){
 if(!entries.length)return null;
 return <section><h2>Native P4 identity</h2><p>Link the username you use for native review comments to your OpenReview account for this project. This is separate from your local bridge login.</p>{entries.map(entry=><Identity key={entry.repositoryId} entry={entry} asOf={asOf}/>)}</section>;
}
