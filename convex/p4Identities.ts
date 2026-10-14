import {query,mutation,internalQuery,internalMutation,type QueryCtx,type MutationCtx} from './_generated/server';
import {v} from 'convex/values';
import type {Id} from './_generated/dataModel';
import {authenticated,authorizeRepository,repositoryAccess,visibleRepositories,audit} from './auth';
import {connectionDigest} from './indexAuthority';
import {p4FixAuthority} from './p4FixAuthority';
export const authorize=internalQuery({args:{token:v.string(),repositoryId:v.id('repositories')},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true);
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(!connection?.active||connection.suspended||connection.kind!=='perforce'||connection.organizationId!==repo.organizationId||!repo.externalId)throw new Error('Active P4 project required');
 return {repo,user,connection};
}});
export const save=internalMutation({args:{token:v.string(),repositoryId:v.id('repositories'),connectionId:v.id('providerConnections'),digest:v.string(),username:v.string(),credentials:v.string()},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true),connection=await ctx.db.get(a.connectionId);
 if(repo.connectionId!==a.connectionId||!connection?.active||connection.suspended||connection.kind!=='perforce'||connection.organizationId!==repo.organizationId||await connectionDigest(connection.credentials)!==a.digest||!a.credentials||!a.username.trim())throw new Error('P4 connection changed while linking identity');
 const claimed=await ctx.db.query('p4Identities').withIndex('by_repo_username',q=>q.eq('repositoryId',repo._id).eq('username',a.username)).unique();
 if(claimed&&claimed.userId!==user._id)throw new Error('This native P4 identity is linked to another workspace account');
 const old=await ctx.db.query('p4Identities').withIndex('by_repo_user',q=>q.eq('repositoryId',repo._id).eq('userId',user._id)).unique(),now=Date.now();
 const value={organizationId:repo.organizationId,repositoryId:repo._id,connectionId:a.connectionId,userId:user._id,username:a.username,credentials:a.credentials,connectionDigest:a.digest,active:true,generation:(old?.generation??0)+1,expiresAt:now+24*60*60000,updatedAt:now};
 const id=old?old._id:await ctx.db.insert('p4Identities',{...value,createdAt:now});if(old)await ctx.db.patch(id,value);
 await audit(ctx,repo.organizationId,user._id,'p4.identity.linked',repo._id);return id;
}});
export const revoke=mutation({args:{token:v.string(),identityId:v.id('p4Identities')},handler:async(ctx,a)=>{
 const user=await authenticated(ctx,a.token),identity=await ctx.db.get(a.identityId);
 if(!identity||identity.userId!==user._id)throw new Error('P4 identity not owned by this account');
 await ctx.db.patch(identity._id,{active:false,credentials:undefined,generation:identity.generation+1,updatedAt:Date.now()});
 await audit(ctx,identity.organizationId,user._id,'p4.identity.revoked',identity.repositoryId);
}});
export async function p4IdentityAuthority(ctx:QueryCtx|MutationCtx,id:Id<'p4Identities'>,generation?:number){
 const identity=await ctx.db.get(id);
 if(!identity?.active||!identity.credentials||identity.expiresAt<=Date.now()||generation!==undefined&&identity.generation!==generation)throw new Error('P4 personal identity expired, revoked or replaced');
 const {repo}=await repositoryAccess(ctx,identity.userId,identity.repositoryId,true),connection=await ctx.db.get(identity.connectionId);
 if(repo.organizationId!==identity.organizationId||repo.connectionId!==identity.connectionId||!connection?.active||connection.suspended||connection.kind!=='perforce'||connection.organizationId!==repo.organizationId||await connectionDigest(connection.credentials)!==identity.connectionDigest)throw new Error('P4 personal identity connection authority changed');
 return {identity,repo,connection};
}
export const data=internalQuery({args:{id:v.id('p4Identities'),generation:v.optional(v.number())},handler:(ctx,a)=>p4IdentityAuthority(ctx,a.id,a.generation)});
export const find=internalQuery({args:{repositoryId:v.id('repositories'),username:v.string()},handler:async(ctx,a)=>{
 const identity=await ctx.db.query('p4Identities').withIndex('by_repo_username',q=>q.eq('repositoryId',a.repositoryId).eq('username',a.username)).unique();
 if(!identity)return null;try{return await p4IdentityAuthority(ctx,identity._id);}catch{return null;}
}});
export const list=query({args:{token:v.string(),organizationId:v.id('organizations')},handler:async(ctx,a)=>{
 const user=await authenticated(ctx,a.token),repos=await visibleRepositories(ctx,a.token,a.organizationId),result=[];
 for(const repo of repos){
  const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;if(connection?.kind!=='perforce'||!connection.active||connection.suspended)continue;
  let canLink=true;try{await repositoryAccess(ctx,user._id,repo._id,true);}catch{canLink=false;}
  const identity=await ctx.db.query('p4Identities').withIndex('by_repo_user',q=>q.eq('repositoryId',repo._id).eq('userId',user._id)).unique();
  result.push({repositoryId:repo._id,name:repo.fullName,instance:connection.instance,canLink,identity:identity?{id:identity._id,username:identity.username,active:identity.active,expiresAt:identity.expiresAt}:null});
 }return result;
}});
export async function p4QuestionAuthority(ctx:QueryCtx|MutationCtx,a:{reviewId:Id<'reviews'>;identityId:Id<'p4Identities'>;generation:number}){
 const authority=await p4IdentityAuthority(ctx,a.identityId,a.generation),review=await ctx.db.get(a.reviewId);
 if(!review?.nativeP4||review.repositoryId!==authority.repo._id||review.organizationId!==authority.repo.organizationId||review.status!=='completed')throw new Error('Completed native P4 review required for this personal project');
 const latest=await ctx.db.query('reviews').withIndex('by_pr',q=>q.eq('repositoryId',review.repositoryId).eq('prNumber',review.prNumber)).order('desc').first();
 if(latest?._id!==review._id)throw new Error('Native P4 review superseded');
 const baseline=await p4FixAuthority(ctx,review);
 return {...authority,review,baselineJob:baseline.job};
}
export const contextAuthority=internalQuery({args:{reviewId:v.id('reviews'),identityId:v.id('p4Identities'),generation:v.number()},handler:p4QuestionAuthority});
