import {mutation,internalMutation,internalQuery,type QueryCtx,type MutationCtx} from './_generated/server';
import {internal} from './_generated/api';
import {v} from 'convex/values';
import type {Id} from './_generated/dataModel';
import {p4QuestionAuthority} from './p4Identities';
import {p4PollingAuthority} from './p4Polling';
import {p4PollingReference} from './schema';
import {rateLimit} from './rateLimit';
import {authorizeRepository,audit} from './auth';
import {nativeConversationCommand,nativeCommandAnswer} from '../src/conversation-commands';
import {p4Baseline} from './p4Index';
const id={conversationId:v.id('conversations')},worker={...id,leaseId:v.string()};
export async function p4ConversationAuthority(ctx:QueryCtx|MutationCtx,conversationId:Id<'conversations'>,leaseId?:string){
 const conversation=await ctx.db.get(conversationId),native=conversation?.nativeP4;
 if(!conversation||!native||typeof conversation.githubCommentId!=='number'||leaseId&&(!native.lease||native.lease.id!==leaseId||native.lease.expiresAt<=Date.now()))throw new Error('Native conversation unavailable or worker lease expired');
 const state=await p4QuestionAuthority(ctx,{reviewId:native.reviewId,identityId:native.identityId,generation:native.identityGeneration}),poll=await p4PollingAuthority(ctx,native.polling.id,native.polling.generation);
 if(conversation.repositoryId!==state.repo._id||conversation.organizationId!==state.repo.organizationId||conversation.prNumber!==state.review.prNumber||conversation.author!==state.identity.username||native.revision!==state.review.headSha||poll.repo._id!==state.repo._id||poll.job._id!==state.baselineJob._id)throw new Error('Native conversation authority changed');
 return {...state,conversation};
}
export const enqueue=internalMutation({args:{reviewId:v.id('reviews'),identityId:v.id('p4Identities'),identityGeneration:v.number(),polling:p4PollingReference,pollLease:v.string(),commentId:v.number(),question:v.string(),parentCommentId:v.optional(v.number())},handler:async(ctx,a):Promise<Id<'conversations'>|null>=>{
 const state=await p4QuestionAuthority(ctx,{reviewId:a.reviewId,identityId:a.identityId,generation:a.identityGeneration}),poll=await p4PollingAuthority(ctx,a.polling.id,a.polling.generation,a.pollLease);
 if(poll.repo._id!==state.repo._id||poll.job._id!==state.baselineJob._id||!Number.isSafeInteger(a.commentId)||a.commentId<1||!/@openreview\b/i.test(a.question)||a.question.length>8000||a.parentCommentId!==undefined&&(!Number.isSafeInteger(a.parentCommentId)||a.parentCommentId<1))throw new Error('Native question scope or size invalid');
 const previous=await ctx.db.query('conversations').withIndex('by_repository_comment',q=>q.eq('repositoryId',state.repo._id).eq('githubCommentId',a.commentId)).unique();if(previous)return null;
 await rateLimit(ctx,`conversation:${state.repo.organizationId}`,20);
 const now=Date.now(),conversationId=await ctx.db.insert('conversations',{organizationId:state.repo.organizationId,repositoryId:state.repo._id,prNumber:state.review.prNumber,githubCommentId:a.commentId,author:state.identity.username,question:a.question,parentCommentId:a.parentCommentId,inline:a.parentCommentId!==undefined,status:'queued',attempts:0,createdAt:now,updatedAt:now,nativeP4:{reviewId:a.reviewId,identityId:a.identityId,identityGeneration:a.identityGeneration,revision:state.review.headSha,polling:a.polling}});
 const scheduledId=await ctx.scheduler.runAfter(0,internal.p4ConversationJobs.reply,{conversationId});const row=await ctx.db.get(conversationId);await ctx.db.patch(conversationId,{nativeP4:{...row!.nativeP4!,scheduledId}});return conversationId;
}});
export const claim=internalMutation({args:worker,handler:async(ctx,a)=>{
 const row=await ctx.db.get(a.conversationId);if(!row?.nativeP4||!['queued','answering'].includes(row.status)||(row.attempts??0)>=3||(row.nativeP4.lease?.expiresAt??0)>Date.now())return false;
 try{await p4ConversationAuthority(ctx,a.conversationId);}catch(error){await ctx.db.patch(row._id,{status:'failed',error:(error instanceof Error?error.message:'Native conversation authority changed').slice(0,1000),updatedAt:Date.now(),nativeP4:{...row.nativeP4,lease:undefined,scheduledId:undefined}});return false;}
 if(row.nativeP4.scheduledId){const scheduled=await ctx.db.system.get(row.nativeP4.scheduledId);if(scheduled?.state.kind==='pending')await ctx.scheduler.cancel(row.nativeP4.scheduledId);}
 await ctx.db.patch(row._id,{status:'answering',attempts:(row.attempts??0)+1,error:undefined,updatedAt:Date.now(),nativeP4:{...row.nativeP4,scheduledId:undefined,lease:{id:a.leaseId,expiresAt:Date.now()+15*60000}}});return true;
}});
export const data=internalQuery({args:worker,handler:(ctx,a)=>p4ConversationAuthority(ctx,a.conversationId,a.leaseId)});
export const saveCommand=internalMutation({args:{...worker,inputStorageId:v.optional(v.id('_storage'))},handler:async(ctx,a)=>{
 const state=await p4ConversationAuthority(ctx,a.conversationId,a.leaseId),row=state.conversation,kind=nativeConversationCommand(row.question);if(!kind)throw new Error('Explicit native command required');
 if(row.nativeP4!.command)return;
 let preferenceId:Id<'learnedPreferences'>|undefined;
 if(kind==='rereview'){
  if(!a.inputStorageId)throw new Error('Prepared re-review input required');await p4Baseline(ctx,{repositoryId:state.repo._id,requestedBy:state.identity.userId,baselineJobId:state.baselineJob._id});
 }else{
  if(a.inputStorageId||!row.parentCommentId)throw new Error('Reply to a current published finding to ignore its pattern');
  const comment=await ctx.db.query('reviewComments').withIndex('by_review',q=>q.eq('reviewId',state.review._id)).filter(q=>q.eq(q.field('githubId'),row.parentCommentId)).unique();
  const finding=comment?.fingerprint?await ctx.db.query('findings').withIndex('by_fingerprint',q=>q.eq('repositoryId',row.repositoryId).eq('prNumber',row.prNumber).eq('fingerprint',comment.fingerprint!)).unique():null;
  if(!finding||finding.reviewId!==state.review._id||finding.commitSha!==row.nativeP4!.revision||finding.status!=='open')throw new Error('Current published finding unavailable for this native pattern');
  const source='conversation:'+row._id,existing=await ctx.db.query('learnedPreferences').withIndex('by_source',q=>q.eq('repositoryId',row.repositoryId).eq('source',source)).unique();
  preferenceId=existing?existing._id:await ctx.db.insert('learnedPreferences',{organizationId:row.organizationId,repositoryId:row.repositoryId,category:finding.category,instruction:`Suppress issues matching this rejected pattern: ${finding.title}. Native developer @${row.author} requested suppression in this finding thread.`.slice(0,2000),source,findingId:finding._id,sourceReviewId:state.review._id,conversationId:row._id,enabled:true,createdAt:Date.now(),updatedAt:Date.now()});
  await audit(ctx,row.organizationId,state.identity.userId,'p4.preference.saved',preferenceId);
 }
 const answer=nativeCommandAnswer(kind);await ctx.db.patch(row._id,{answer,updatedAt:Date.now(),nativeP4:{...row.nativeP4!,answerText:answer,citations:[],command:{kind,preferenceId,inputStorageId:a.inputStorageId}}});
}});
export const save=internalMutation({args:{...worker,answer:v.string(),answerText:v.string(),citations:v.array(v.object({filePath:v.string(),startLine:v.number(),quote:v.string(),sha:v.string(),url:v.string()}))},handler:async(ctx,a)=>{
 const {conversation}=await p4ConversationAuthority(ctx,a.conversationId,a.leaseId);if(!a.answer.trim()||a.answer.length>100000||a.answerText.length>12000||a.citations.length>10)throw new Error('Native answer exceeds coverage');await ctx.db.patch(conversation._id,{answer:a.answer,updatedAt:Date.now(),nativeP4:{...conversation.nativeP4!,answerText:a.answerText,citations:a.citations}});
}});
export const finish=internalMutation({args:{...worker,error:v.optional(v.string()),replyId:v.optional(v.number())},handler:async(ctx,a)=>{
 const row=await ctx.db.get(a.conversationId);if(!row?.nativeP4||row.nativeP4.lease?.id!==a.leaseId||row.nativeP4.lease.expiresAt<=Date.now())return false;
 let requestedReviewId:Id<'reviews'>|undefined;
 if(!a.error){const state=await p4ConversationAuthority(ctx,a.conversationId,a.leaseId);if(!row.answer||!Number.isSafeInteger(a.replyId)||a.replyId!<1)throw new Error('Native reply evidence missing');
  if(row.nativeP4.command?.kind==='rereview'){
   if(!row.nativeP4.command.inputStorageId||row.answer!==nativeCommandAnswer('rereview')||nativeConversationCommand(row.question)!=='rereview')throw new Error('Native command receipt invalid');
   requestedReviewId=await ctx.runMutation(internal.p4Reviews.enqueue,{repositoryId:row.repositoryId,requestedBy:state.identity.userId,nativeNumber:row.prNumber,revision:row.nativeP4.revision,baseRevision:state.review.baseSha!,baselineJobId:state.baselineJob._id,inputStorageId:row.nativeP4.command.inputStorageId,credentialDigest:state.review.nativeP4!.credentialDigest,connectionId:state.connection._id,force:true});
   await audit(ctx,row.organizationId,state.identity.userId,'p4.conversation.rereview',requestedReviewId);
  }
 }
 const retry=!!a.error&&(row.attempts??0)<3,scheduledId=retry?await ctx.scheduler.runAfter(10000*(row.attempts??1),internal.p4ConversationJobs.reply,{conversationId:row._id}):undefined;
 await ctx.db.patch(row._id,{status:a.error?(retry?'queued':'failed'):'completed',error:a.error?.slice(0,1000),updatedAt:Date.now(),nativeP4:{...row.nativeP4,lease:undefined,scheduledId,...(!a.error?{replyId:a.replyId}:{}),...(requestedReviewId?{command:{...row.nativeP4.command!,requestedReviewId}}:{})}});return true;
}});
export const recover=internalMutation({args:{},handler:async(ctx)=>{
 for(const status of ['queued','answering'])for(const row of await ctx.db.query('conversations').withIndex('by_status',q=>q.eq('status',status)).take(100)){
  if(!row.nativeP4||(row.nativeP4.lease?.expiresAt??0)>Date.now())continue;
  const scheduled=row.nativeP4.scheduledId?await ctx.db.system.get(row.nativeP4.scheduledId):null;if(scheduled&&['pending','inProgress'].includes(scheduled.state.kind))continue;
  try{await p4ConversationAuthority(ctx,row._id);if((row.attempts??0)>=3)throw new Error('Native reply recovery exhausted');}
  catch(error){await ctx.db.patch(row._id,{status:'failed',error:error instanceof Error?error.message:'Native reply authority unavailable',updatedAt:Date.now(),nativeP4:{...row.nativeP4,lease:undefined,scheduledId:undefined}});continue;}
  const scheduledId=await ctx.scheduler.runAfter(0,internal.p4ConversationJobs.reply,{conversationId:row._id});await ctx.db.patch(row._id,{status:'queued',updatedAt:Date.now(),nativeP4:{...row.nativeP4,lease:undefined,scheduledId}});
 }
}});
export const retry=mutation({args:{token:v.string(),conversationId:v.id('conversations')},handler:async(ctx,a)=>{
 const row=await ctx.db.get(a.conversationId);if(!row?.nativeP4||row.status!=='failed'||(row.nativeP4.lease?.expiresAt??0)>Date.now())throw new Error('No failed native answer to retry');
 const {user}=await authorizeRepository(ctx,a.token,row.repositoryId,true),identity=await ctx.db.get(row.nativeP4.identityId);
 if(!identity||identity.userId!==user._id)throw new Error('Only the linked native question author can retry this answer');
 const state=await p4QuestionAuthority(ctx,{reviewId:row.nativeP4.reviewId,identityId:identity._id,generation:identity.generation}),poll=await ctx.db.query('p4Polls').withIndex('by_repo',q=>q.eq('repositoryId',row.repositoryId)).unique();
 if(!poll)throw new Error('Enable native polling before retrying');const authorized=await p4PollingAuthority(ctx,poll._id,poll.generation);
 if(state.review.headSha!==row.nativeP4.revision||authorized.job._id!==state.baselineJob._id)throw new Error('Native answer revision or baseline superseded; ask on the current review');
 await rateLimit(ctx,`conversation:${state.repo.organizationId}`,20);
 const scheduledId=await ctx.scheduler.runAfter(0,internal.p4ConversationJobs.reply,{conversationId:row._id});
 await ctx.db.patch(row._id,{status:'queued',error:undefined,attempts:0,updatedAt:Date.now(),nativeP4:{...row.nativeP4,identityGeneration:identity.generation,polling:{id:poll._id,generation:poll.generation},lease:undefined,scheduledId}});await audit(ctx,state.repo.organizationId,user._id,'p4.conversation.retry',row._id);
}});
