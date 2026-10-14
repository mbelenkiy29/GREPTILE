"use node";
import {action} from './_generated/server';
import {api,internal} from './_generated/api';
import {v} from 'convex/values';
import type {Id} from './_generated/dataModel';
export const request=action({args:{token:v.string(),repositoryId:v.id('repositories'),prNumber:v.number(),expectedRevision:v.string(),expectedBaseRevision:v.string()},handler:async(ctx,a):Promise<Id<'reviews'>|null>=>{
 const access=await ctx.runQuery(internal.pulls.requestContext,a);
 if(access.nativeP4)return ctx.runAction(api.p4ReviewJobs.request,{token:a.token,organizationId:access.organizationId,repositoryId:a.repositoryId,nativeNumber:a.prNumber,expectedRevision:a.expectedRevision,expectedBaseRevision:a.expectedBaseRevision});
 return ctx.runAction(api.providerJobs.rereview,{token:a.token,repositoryId:a.repositoryId,prNumber:a.prNumber,expectedRevision:a.expectedRevision,expectedRevisionKey:access.revisionKey,force:false});
}});
