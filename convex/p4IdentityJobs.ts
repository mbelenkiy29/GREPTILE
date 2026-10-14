"use node";
import {action,internalAction} from './_generated/server';
import {internal} from './_generated/api';
import {v} from 'convex/values';
import type {Id} from './_generated/dataModel';
import {P4CodeReview,P4Error,p4Credential,type P4Comment} from '../src/perforce';
import {encryptCredential,decryptCredential} from '../src/credentials';
import {connectionDigest} from './indexAuthority';
import {parseP4SubmittedInventory} from '../src/p4-index';
import {eligibleFile,redact} from '../src/engine/indexer';
import {z} from 'zod';
import {nativeConversationCommand} from '../src/conversation-commands';
export const connect=action({args:{token:v.string(),repositoryId:v.id('repositories'),username:v.string(),ticket:v.string()},handler:async(ctx,a):Promise<Id<'p4Identities'>>=>{
 const credential=p4Credential.parse({username:a.username,ticket:a.ticket}),state=await ctx.runQuery(internal.p4Identities.authorize,{token:a.token,repositoryId:a.repositoryId});
 // Native Basic authentication verifies the claimed username with its own ticket, never with the bot credential.
 const client=new P4CodeReview(state.connection.instance,credential.username,credential.ticket);await client.authenticatedIdentity();await client.project(state.repo.externalId!);
 const scope=state.repo.organizationId+':p4-personal:'+state.repo._id+':'+state.user._id;
 return ctx.runMutation(internal.p4Identities.save,{token:a.token,repositoryId:a.repositoryId,connectionId:state.connection._id,digest:await connectionDigest(state.connection.credentials),username:credential.username,credentials:encryptCredential(JSON.stringify(credential),scope)});
}});
// Every factual source is read with the native comment author's ticket, including unchanged baseline callers.
export const context=internalAction({args:{reviewId:v.id('reviews'),identityId:v.id('p4Identities'),generation:v.number(),questionId:v.number()},handler:async(ctx,a):Promise<{question:P4Comment;sources:{path:string;content:string;sha:string;url:string}[];coverage:string[];revision:string;version:number;reviewNumber:number;identityGeneration:number}>=>{
 const authority={reviewId:a.reviewId,identityId:a.identityId,generation:a.generation},state=await ctx.runQuery(internal.p4Identities.contextAuthority,authority);
 const credential=p4Credential.parse(JSON.parse(decryptCredential(state.identity.credentials!,state.repo.organizationId+':p4-personal:'+state.repo._id+':'+state.identity.userId)));
 if(credential.username!==state.identity.username)throw new Error('Native personal identity credential mismatch');
 const client=new P4CodeReview(state.connection.instance,credential.username,credential.ticket),snapshot=await client.snapshot(state.repo.externalId!,state.review.prNumber);
 if(snapshot.revision!==state.review.headSha||!snapshot.review.pending||!['needsReview','needsRevision'].includes(snapshot.review.state))throw new Error('P4 question shelf changed or closed');
 await client.authenticatedIdentity();
 const comments=await client.comments(snapshot),question=comments.find(c=>c.id===a.questionId);
 if(!question||question.user!==state.identity.username||question.flags.includes('closed')||!/@openreview\b/i.test(question.body)||Buffer.byteLength(question.body)>16000)throw new Error('Current native question does not belong to this linked identity');
 const blob=await ctx.storage.get(state.baselineJob.manifestStorageId!);if(!blob||blob.size>1000000)throw new Error('P4 question baseline manifest unavailable');
 const stored=z.object({sha:z.string(),inventory:z.unknown()}).parse(JSON.parse(await blob.text())),inventory=parseP4SubmittedInventory(stored.inventory);
 if(stored.sha!==state.review.baseSha||inventory.revision!==state.review.baseSha)throw new Error('P4 question baseline identity changed');
 const project=await client.project(state.repo.externalId!);
 if(JSON.stringify(project)!==JSON.stringify(inventory.project))throw new Error('P4 personal project views changed');
 const parent=question.context.comment?comments.find(c=>c.id===question.context.comment):undefined;
 if(question.context.comment&&!parent)throw new Error('Native question parent unavailable to its author');
 if(nativeConversationCommand(question.body)==='ignore-pattern'){
  const target=question.context.comment?await ctx.runQuery(internal.conversations.target,{repositoryId:state.repo._id,prNumber:state.review.prNumber,commentId:question.context.comment}):null;
  const bot=p4Credential.parse(JSON.parse(decryptCredential(state.connection.credentials,state.repo.organizationId+':perforce')));
  if(!parent||parent.user!==bot.username||parent.flags.includes('closed')||!target||target.reviewId!==state.review._id||target.commitSha!==snapshot.revision||target.status!=='open'||!parent.body.includes('<!-- openreview-finding:'+target.fingerprint+' -->'))throw new Error('Reply to a current published finding to ignore its pattern');
 }
 const paths=new Set<string>([...(question.context.file?[question.context.file.slice(2)]:[]),...(parent?.context.file?[parent.context.file.slice(2)]:[]),...snapshot.files.map(f=>f.depotFile.slice(2))]);
 const related=await ctx.runQuery(internal.context.related,{repositoryId:state.repo._id,paths:[...paths],identifiers:[...new Set(question.body.match(/[A-Za-z_]\w{3,}/g)??[])].slice(0,30)});for(const p of related.paths)paths.add(p);
 const sources:{path:string;content:string;sha:string;url:string}[]=[],coverage:string[]=[...snapshot.coverage];let remaining=40000;
 for(const p of [...paths].slice(0,20)){
  if(remaining<=0)break;
  if(!eligibleFile({path:p,content:'',sha:''}))continue;
  const depot='//'+p,changed=snapshot.files.find(f=>f.depotFile===depot),baseline=inventory.manifest.find(f=>f.depotFile===depot);
  if(changed&&['delete','move/delete'].includes(changed.action)||!changed&&!baseline)continue;
  try{
   const file=changed?await client.content(snapshot,depot):await client.submittedContent(project,baseline!,inventory.serverId,inventory.change);
   if(!eligibleFile({...file,path:p}))continue;
   const content=redact(file.content.slice(0,Math.min(10000,remaining)));remaining-=content.length;
   const revision=changed?'@='+snapshot.change:'#'+baseline!.headRev;
   sources.push({path:p,content,sha:file.sha,url:client.base+'/view/'+p.split('/').map(encodeURIComponent).join('/')+'?v='+encodeURIComponent(revision)});
  }catch(error){if(error instanceof P4Error&&[403,404].includes(error.status)){coverage.push('Source unavailable to native question author: '+p);continue;}throw error;}
 }
 if(paths.size>20||remaining<=0)coverage.push('Follow-up source context is bounded to 20 files and 40,000 characters.');
 await ctx.runQuery(internal.p4Identities.contextAuthority,authority);
 await client.authenticatedIdentity();
 const final=await client.snapshot(state.repo.externalId!,state.review.prNumber);if(final.revision!==snapshot.revision||!final.review.pending||!['needsReview','needsRevision'].includes(final.review.state))throw new Error('P4 question revision or open state changed during retrieval');
 const currentQuestion=(await client.comments(final)).find(c=>c.id===question.id);if(!currentQuestion||currentQuestion.body!==question.body||currentQuestion.user!==question.user||JSON.stringify(currentQuestion.context)!==JSON.stringify(question.context)||currentQuestion.flags.includes('closed'))throw new Error('Native question changed during retrieval');
 return {question,sources,coverage,revision:snapshot.revision,version:snapshot.version,reviewNumber:snapshot.review.id,identityGeneration:state.identity.generation};
}});
