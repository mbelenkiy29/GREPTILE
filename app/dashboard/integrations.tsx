import {repositoryDisplay} from "../../src/provider-display";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, origin } from "../../src/server";
import { configureLinear, configureAtlassian, disconnectLinear, refreshLinear } from "./actions";

export async function IntegrationsPanel({token,organizationId,admin,repositories,selected,error,saved}:{token:string;organizationId:Id<"organizations">;admin:boolean;repositories:{_id:Id<"repositories">;fullName:string}[];selected?:string;error?:string;saved?:string}) {
 const connections=await backend().query(api.integrations.list,{token,organizationId});
 let atlassianResources:{projects:{id:string;name:string}[];spaces:{id:string;name:string}[]}|undefined;
 const connection=connections.find(c=>c._id===selected&&c.active);
 let resources:{teams:{id:string;name:string;key:string}[];projects:{id:string;name:string}[]}|undefined,discoveryFailed=false;
 if(admin&&connection)try {if(connection.kind==="linear")resources=await backend().action(api.integrationJobs.discover,{token,id:connection._id});else atlassianResources=await backend().action(api.atlassianJobs.discover,{token,id:connection._id});}catch{discoveryFailed=true;}
 return <>
  <section><h2>Requirements integrations</h2><p>Connect Linear or Atlassian with read-only access. Select resources and the repositories allowed to use their requirements.</p>
   {error&&<p role="alert" className="error">{error==="disconnect"?"Disconnect failed. Check workspace admin access and retry.":error==="linear-refresh"?"Connection refresh failed. Retry after any refresh in progress finishes, or reconnect if Linear access was revoked.":error.endsWith("-connect")?"Authorization failed or expired. Reconnect and approve read-only access.":"Scope could not be saved. Check your permissions and refresh the resource list before retrying."}</p>}
   {saved&&(saved!=="linear-refresh"||Boolean(connection))&&<p role="status">{saved==="disconnected"?"Connection disconnected. Requirements access removed.":saved==="linear-refresh"?"Linear connection refreshed.":"Resource scope saved."}</p>}
   {!connections.length&&<p className="muted">No requirements integrations connected.</p>}
   {connections.map(c=><article className="repository" key={c._id}><div className="row"><h3>{c.name} · {c.kind==="linear"?"Linear":"Atlassian"}</h3><span className="badge">{c.active?"Connected":"Disconnected"}</span></div>
    {c.kind==="linear"?<p>{c.teamIds.length} teams · {c.projectIds.length?c.projectIds.length+" selected projects":"All projects in selected teams"} · {c.repositoryIds.length} repositories</p>:<p>{c.jiraProjectIds.length} Jira projects · {c.confluenceSpaceIds.length} Confluence spaces · {c.repositoryIds.length} repositories</p>}
    {!(c.teamIds.length||c.jiraProjectIds.length||c.confluenceSpaceIds.length)&&c.active&&<p className="muted">Select resources and repositories to authorize retrieval.</p>}
    {c.error&&<p role="alert">{c.error}</p>}{c.kind==="atlassian"&&!c.active&&<a href="https://id.atlassian.com/manage-profile/apps" target="_blank" rel="noreferrer">Revoke in Atlassian Connected Apps</a>}
    {admin&&c.active&&<div className="row"><Link className="button" href={"/dashboard/memory/integrations?integration="+c._id}>Select resources</Link>{c.kind==="linear"&&<form action={refreshLinear}><input type="hidden" name="integrationId" value={c._id}/><button>Refresh Linear connection</button></form>}<form action={disconnectLinear}><input type="hidden" name="integrationId" value={c._id}/><button>Disconnect {c.kind==="linear"?"Linear":"Atlassian"}</button></form></div>}
   </article>)}
   {admin&&(process.env.LINEAR_CLIENT_ID?<a className="button primary" href={"/api/integrations/linear/connect?organization="+organizationId}>Connect Linear workspace</a>:<details open><summary>Linear OAuth setup required</summary><p>Create a Linear OAuth application with read scope and PKCE. Set <code>LINEAR_CLIENT_ID</code> on the web application and Convex backend. Register this callback:</p><code className="integration-callback">{origin()+"/api/integrations/linear/callback"}</code></details>)}
   {admin&&(process.env.ATLASSIAN_CLIENT_ID&&process.env.ATLASSIAN_CLIENT_SECRET?<a className="button primary" href={"/api/integrations/atlassian/connect?organization="+organizationId}>Connect Atlassian sites</a>:<details open><summary>Atlassian OAuth setup required</summary><p>The OpenReview operator registers a distributable OAuth 3LO app with read-only Jira and Confluence scopes and offline access. Set <code>ATLASSIAN_CLIENT_ID</code> and server-only <code>ATLASSIAN_CLIENT_SECRET</code> on the web application and Convex backend. Register this callback:</p><code className="integration-callback">{origin()+"/api/integrations/atlassian/callback"}</code></details>)}
  </section>
  {discoveryFailed&&<section><p role="alert">Integration resources could not be loaded. Access may have expired, or another request is refreshing the token.</p><Link className="button" href={"/dashboard/memory/integrations?integration="+selected}>Retry resource discovery</Link></section>}
  {connection&&resources&&<section><h2>Select resources · {connection.name}</h2><form action={configureLinear} className="form-grid policy-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <fieldset><legend>Linear teams</legend>{resources.teams.length?resources.teams.map(t=><label className="check" key={t.id}><input type="checkbox" name="teamIds" value={t.id} defaultChecked={connection.teamIds.includes(t.id)}/>{t.name} · {t.key}</label>):<p>No authorized teams found.</p>}</fieldset>
   <fieldset><legend>Optional project restriction</legend><p className="muted">With no projects selected, all issues in selected teams are allowed, including issues without a project. Selecting projects excludes issues without a selected project.</p>{resources.projects.map(p=><label className="check" key={p.id}><input type="checkbox" name="projectIds" value={p.id} defaultChecked={connection.projectIds.includes(p.id)}/>{p.name}</label>)}</fieldset>
   <fieldset><legend>Repositories allowed to retrieve requirements</legend>{repositories.map(r=><label className="check repository-choice" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={connection.repositoryIds.includes(r._id)}/><span>{repositoryDisplay(r)}</span></label>)}</fieldset>
   <button className="primary">Save resource scope</button>
  </form></section>}
  {connection&&atlassianResources&&<section><h2>Select resources · {connection.name}</h2><form action={configureAtlassian} className="form-grid policy-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <fieldset><legend>Jira projects</legend>{atlassianResources.projects.length?atlassianResources.projects.map(p=><label className="check" key={p.id}><input type="checkbox" name="jiraProjectIds" value={p.id} defaultChecked={connection.jiraProjectIds.includes(p.id)}/>{p.name}</label>):<p>No authorized Jira projects found.</p>}</fieldset>
   <fieldset><legend>Confluence spaces</legend>{atlassianResources.spaces.length?atlassianResources.spaces.map(p=><label className="check" key={p.id}><input type="checkbox" name="confluenceSpaceIds" value={p.id} defaultChecked={connection.confluenceSpaceIds.includes(p.id)}/>{p.name}</label>):<p>No authorized Confluence spaces found.</p>}</fieldset>
   <fieldset><legend>Repositories allowed to retrieve requirements</legend>{repositories.map(r=><label className="check repository-choice" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={connection.repositoryIds.includes(r._id)}/><span>{repositoryDisplay(r)}</span></label>)}</fieldset>
   <p className="muted">Only Jira keys and Confluence page links explicitly referenced in the PR title, description, or branch are fetched. Selecting no resources disables retrieval.</p>
   <button className="primary">Save resource scope</button>
  </form></section>}
 </>;
}
