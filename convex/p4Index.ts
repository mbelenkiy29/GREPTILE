import {internalQuery,query} from "./_generated/server";
import {v} from "convex/values";
import {authorizeRepository,repositoryAccess} from "./auth";
import {connectionDigest} from "./indexAuthority";
import type {QueryCtx,MutationCtx} from "./_generated/server";
import type {Id} from "./_generated/dataModel";
export const authorize=internalQuery({args:{token:v.string(),organizationId:v.id("organizations"),repositoryId:v.id("repositories")},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true,true);
 if(repo.organizationId!==a.organizationId||!repo.connectionId)throw new Error("P4 repository unavailable in API key workspace");
 const c=await ctx.db.get(repo.connectionId);
 if(!c?.active||c.suspended||c.kind!=="perforce"||c.organizationId!==repo.organizationId)throw new Error("P4 connection unavailable");
 return {repo,connection:c,nativeDepot:{requestedBy:user._id,connectionId:c._id,credentialDigest:await connectionDigest(c.credentials)}};
}});
export const status=query({args:{token:v.string(),organizationId:v.id("organizations"),repositoryId:v.id("repositories")},handler:async(ctx,a)=>{
 const {repo}=await authorizeRepository(ctx,a.token,a.repositoryId,true,true);
 const c=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(repo.organizationId!==a.organizationId||!c?.active||c.suspended||c.kind!=="perforce"||c.organizationId!==repo.organizationId||!repo.externalId)throw new Error("P4 connection unavailable");
 return {repositoryId:repo._id,projectId:repo.externalId,instance:c.instance,indexStatus:repo.indexStatus,revision:repo.indexedSha??null,error:repo.error??null};
}});
export async function p4BaselineMetadata(ctx:QueryCtx|MutationCtx,a:{repositoryId:Id<"repositories">;requestedBy:Id<"users">;baselineJobId?:Id<"indexJobs">}){
 const {repo}=await repositoryAccess(ctx,a.requestedBy,a.repositoryId,true,true);
 if(!repo.connectionId||repo.indexStatus!=="ready"||!repo.indexedSha)throw new Error("P4 indexing must complete before shelf ingestion");
 const connection=await ctx.db.get(repo.connectionId);
 if(!connection?.active||connection.suspended||connection.kind!=="perforce"||connection.organizationId!==repo.organizationId)throw new Error("P4 connection unavailable");
 const job=a.baselineJobId?await ctx.db.get(a.baselineJobId):await ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).order("desc").first();
 if(!job?.nativeDepot||job.repositoryId!==repo._id||job.organizationId!==repo.organizationId||job.status!=="completed"||job.sha!==repo.indexedSha||!job.manifestStorageId||job.nativeDepot.connectionId!==connection._id||job.nativeDepot.credentialDigest!==await connectionDigest(connection.credentials))throw new Error("P4 submitted baseline is stale or unavailable; re-index before reviewing");
 return {repo,connection,job};
}
export async function p4Baseline(ctx:QueryCtx|MutationCtx,a:{repositoryId:Id<"repositories">;requestedBy:Id<"users">;baselineJobId?:Id<"indexJobs">}){
 const state=await p4BaselineMetadata(ctx,a);
 const files=await ctx.db.query("repositoryFiles").withIndex("by_repo",q=>q.eq("repositoryId",state.repo._id)).collect();
 return {...state,files};
}
export const baseline=internalQuery({args:{repositoryId:v.id("repositories"),requestedBy:v.id("users"),baselineJobId:v.optional(v.id("indexJobs"))},handler:p4Baseline});
