"use node";
import {internalAction} from './_generated/server';
import {internal} from './_generated/api';
import {v} from 'convex/values';
import {randomUUID} from 'node:crypto';
import {P4CodeReview,p4Credential} from '../src/perforce';
import {decryptCredential} from '../src/credentials';
import {redact} from '../src/redact';
import picomatch from 'picomatch';
export const step=internalAction({args:{id:v.id('p4Polls'),generation:v.number()},handler:async(ctx,a)=>{
 const worker={...a,leaseId:randomUUID()};
 if(!await ctx.runMutation(internal.p4Polling.claim,worker))return;
 try{
  const state=await ctx.runQuery(internal.p4Polling.data,worker);
  const credential=p4Credential.parse(JSON.parse(decryptCredential(state.connection.credentials,state.repo.organizationId+':perforce')));
  const client=new P4CodeReview(state.connection.instance,credential.username,credential.ticket),project=state.repo.externalId!;
  if(state.poll.position===state.poll.pending.length){
   if(state.poll.pages>100)throw new Error('P4 inventory exceeds 100 pages / 10,000 reviews; complete polling unavailable');
   await client.project(project);
   const page=await client.reviewPage(project,state.poll.cursor);
   await ctx.runMutation(internal.p4Polling.progress,{...worker,page:{ids:page.reviews.map(r=>r.id),cursor:page.cursor}});return;
  }
  const observedAt=Date.now(),nativeNumber=state.poll.pending[state.poll.position],native=await client.reviewStatus(project,nativeNumber);
  const open=native.pending&&['needsReview','needsRevision'].includes(native.state);
  // A pinned file inventory establishes the same opaque revision used by actual reviews; no source bodies or models are read.
  const snapshot=open&&native.versions.at(-1)?.archiveChange?await client.snapshot(project,nativeNumber):null;
  const metadata=snapshot?.review??native;
  const revision=snapshot?.revision??`p4-status:${metadata.id}:${metadata.versions.length}:${metadata.versions.at(-1)?.archiveChange??metadata.versions.at(-1)?.change}:${metadata.updated}`;
  await ctx.runMutation(internal.p4Polling.observe,{...worker,nativeNumber,title:metadata.description.split('\n')[0].slice(0,2000)||'P4 review '+nativeNumber,author:metadata.author,url:state.connection.instance+'/reviews/'+nativeNumber,revision,state:metadata.pending&&['needsReview','needsRevision'].includes(metadata.state)?'open':'closed',observedAt});
  let skippedReason:string|undefined;
  if(!metadata.pending||!['needsReview','needsRevision'].includes(metadata.state))await ctx.runMutation(internal.p4Polling.closed,{...worker,nativeNumber});
  else if(!snapshot)skippedReason='No archived pending shelf; stable review revision unavailable';
  else{
   const previous=await ctx.runQuery(internal.p4Polling.previous,{...worker,nativeNumber}),config=await ctx.runQuery(internal.repositories.data,{repositoryId:state.repo._id});
   if(previous?.status==='completed'&&previous.nativeP4)await ctx.runAction(internal.p4ConversationJobs.discover,{reviewId:previous._id,polling:{id:a.id,generation:a.generation},pollLease:worker.leaseId});
   const branches=metadata.projects[project];
   if(!config.settings.automatic||previous&&!config.settings.rereview||config.settings.targetBranches.length&&!branches.some(b=>picomatch(config.settings.targetBranches)(b))||branches.some(b=>picomatch(config.settings.ignoredBranches)(b)))skippedReason='Automatic review, re-review or native project branch policy excludes this shelf';
   else{
    // Failed same-revision analysis stays visible for explicit human retry.
    if(!(previous?.headSha===snapshot.revision&&previous.baseSha===state.job.sha&&previous.status!=='cancelled')){
     const prepared=await ctx.runAction(internal.p4ShelfJobs.prepare,{repositoryId:state.repo._id,requestedBy:state.poll.requestedBy,reviewId:nativeNumber,baselineJobId:state.job._id,revision:snapshot.revision});
     try{
      await ctx.runQuery(internal.p4Polling.data,worker);
      await ctx.runMutation(internal.p4Reviews.enqueue,{repositoryId:state.repo._id,requestedBy:state.poll.requestedBy,nativeNumber,revision:prepared.revision,baseRevision:prepared.baseRevision,baselineJobId:prepared.baselineJobId,inputStorageId:prepared.storageId,connectionId:state.connection._id,credentialDigest:state.poll.credentialDigest,polling:{id:a.id,generation:a.generation},pollLease:worker.leaseId,branches});
     }catch(error){await ctx.storage.delete(prepared.storageId);throw error;}
    }
   }
  }
  await ctx.runMutation(internal.p4Polling.progress,{...worker,processed:true,skippedReason});
 }catch(error){await ctx.runMutation(internal.p4Polling.progress,{...worker,error:redact(error instanceof Error?error.message:'P4 polling failed').slice(0,1000)});}
}});
