import type {MutationCtx,QueryCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";
import {repositoryAccess} from "./auth";
export async function connectionDigest(credentials:string){
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(credentials));
 return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,"0")).join("");
}
export function indexBatchMatches(job:Doc<"indexJobs">,leaseId?:string){return job.batchLease?job.batchLease.id===leaseId&&job.batchLease.expiresAt>Date.now():leaseId===undefined;}
export async function indexWriteAllowed(ctx:QueryCtx|MutationCtx,repo:Doc<"repositories">|null,job:Pick<Doc<"indexJobs">,"repositoryId"|"organizationId"|"status"|"nativeDepot">|null){
 if(!repo||!job||job.repositoryId!==repo._id||job.organizationId!==repo.organizationId||job.status!=="running")return false;
 if(!job.nativeDepot)return repo.enabled;
 const native=job.nativeDepot,c=await ctx.db.get(native.connectionId);
 if(repo.connectionId!==native.connectionId||!c?.active||c.suspended||c.kind!=="perforce"||c.organizationId!==repo.organizationId||await connectionDigest(c.credentials)!==native.credentialDigest)return false;
 try{await repositoryAccess(ctx,native.requestedBy,repo._id,true,true);return true;}catch{return false;}
}
