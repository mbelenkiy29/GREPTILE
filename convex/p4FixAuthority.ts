import type {QueryCtx,MutationCtx} from './_generated/server';
import type {Doc} from './_generated/dataModel';
import {p4Baseline} from './p4Index';
import {connectionDigest} from './indexAuthority';
export async function p4FixAuthority(ctx:QueryCtx|MutationCtx,review:Doc<'reviews'>){
 if(!review.nativeP4)throw new Error('Native P4 review unavailable');
 const b=await p4Baseline(ctx,{repositoryId:review.repositoryId,requestedBy:review.nativeP4.requestedBy,baselineJobId:review.nativeP4.baselineJobId});
 if(b.connection._id!==review.nativeP4.connectionId||await connectionDigest(b.connection.credentials)!==review.nativeP4.credentialDigest||b.job.sha!==review.baseSha)throw new Error('P4 review baseline or credentials changed; re-review before fixing');
 return b;
}
