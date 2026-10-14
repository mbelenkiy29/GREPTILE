import {query,mutation} from "./_generated/server";
import {v} from "convex/values";
import {authorize,visibleRepositories,audit} from "./auth";
import {indexingAccess,enableIndexing} from "./repositories";
import {connectionDigest} from "./indexAuthority";
import type {QueryCtx,MutationCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";
import {repositoryIdentity} from "./repositoryIdentity";

async function setupAccess(ctx:QueryCtx|MutationCtx,repo:Doc<"repositories">){
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(connection?.kind!=="perforce")return {nativeIndex:false,setupError:await indexingAccess(ctx,repo)};
 return {nativeIndex:true,setupError:connection.organizationId!==repo.organizationId||!connection.active||connection.suspended?"Provider access is disconnected or suspended":!repo.externalId?"Native project identity is unavailable":null};
}

export const status=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 const {member}=await authorize(ctx,a.token,a.organizationId),organization=await ctx.db.get(a.organizationId);
 const repositories=await visibleRepositories(ctx,a.token,a.organizationId);
 const selectedIds=organization?.onboardingRepositoryIds??repositories.filter(r=>r.enabled).map(r=>r._id);
 const settings=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const rows=await Promise.all(repositories.map(async r=>{
  const access=await setupAccess(ctx,r),job=await ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",r._id)).order("desc").first();
  const connectedProvider=r.connectionId?await ctx.db.get(r.connectionId):null;
  const connection=connectedProvider?.organizationId===r.organizationId?connectedProvider:null;
  const provider=await repositoryIdentity(ctx,r);
  const nativeReady=Boolean(connection&&!access.setupError&&r.indexStatus==="ready"&&r.indexedSha&&job?.status==="completed"&&job.organizationId===r.organizationId&&job.sha===r.indexedSha&&job.manifestStorageId&&job.nativeDepot?.connectionId===connection._id&&job.nativeDepot.credentialDigest===await connectionDigest(connection.credentials));
  return {...r,...access,provider,selected:selectedIds.includes(r._id),job,ready:access.nativeIndex?nativeReady:r.enabled&&r.indexStatus==="ready"};
 }));
 const selected=rows.filter(r=>r.selected),configured=settings.some(s=>!s.teamId);
 const installations=await ctx.db.query("githubInstallations").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const connections=await ctx.db.query("providerConnections").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const connected=installations.some(c=>c.active)||connections.some(c=>c.active&&!c.suspended);
 // Progress is derived from current authorized state, including connection revocation.
 const unavailableSelection=selectedIds.some(id=>!rows.some(r=>r._id===id));
 const step=!connected?2:unavailableSelection||!selected.length||selected.some(r=>r.setupError)?3:!configured?4:!selected.every(r=>r.ready)?5:6;
 return {repositories:rows,configured,step,unavailableSelection,admin:["owner","admin"].includes(member.role)};
}});
export const select=mutation({args:{token:v.string(),organizationId:v.id("organizations"),repositoryIds:v.array(v.id("repositories"))},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 const repos=await visibleRepositories(ctx,a.token,a.organizationId),ids=[...new Set(a.repositoryIds)];
 if(!ids.length||ids.length!==a.repositoryIds.length)throw new Error("Select at least one repository without duplicates");
 for(const id of ids){const r=repos.find(r=>r._id===id);if(!r)throw new Error("Repository is outside this workspace");const {setupError}=await setupAccess(ctx,r);if(setupError)throw new Error(setupError);}
 await ctx.db.patch(a.organizationId,{onboardingRepositoryIds:ids});await audit(ctx,a.organizationId,user._id,"onboarding.repositories_selected",a.organizationId);
}});
export const start=mutation({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true),organization=await ctx.db.get(a.organizationId);
 const settings=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 if(!settings.some(s=>!s.teamId))throw new Error("Save workspace behavior before indexing");
 const repos=await visibleRepositories(ctx,a.token,a.organizationId),ids=organization?.onboardingRepositoryIds??repos.filter(r=>r.enabled).map(r=>r._id);
 if(!ids.length)throw new Error("Select repositories before indexing");
 let started=false;
 for(const id of ids){const r=repos.find(r=>r._id===id);if(!r)throw new Error("Selected repository is unavailable");const access=await setupAccess(ctx,r);if(access.setupError)throw new Error(access.setupError);if(!access.nativeIndex){await enableIndexing(ctx,r);started=true;}}
 if(!started)throw new Error("Use native Perforce indexing setup for the selected repositories");
 await audit(ctx,a.organizationId,user._id,"onboarding.indexing_started",a.organizationId);
}});
