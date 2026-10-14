"use node";
import { action,internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { z } from "zod";
import { createHash,timingSafeEqual } from "node:crypto";
import { decryptCredential,encryptCredential } from "../src/credentials";
import { verifyWebhook } from "../src/github";
import { provider,discover as discoverRepositories } from "./scm";
import { verifyOriginWebhook } from "../src/origin-auth";
import { Origin } from "../src/origin";
import { BitbucketDC } from "../src/bitbucket-dc";
import { BitbucketCloud } from "../src/bitbucket-cloud";
import { bitbucketEvent } from "../src/bitbucket-events";
import { Gitlab } from "../src/gitlab";
import { Gitea } from "../src/gitea";
import { P4CodeReview,p4Credential,type P4Project,type P4Review,type P4ApprovalInspection } from "../src/perforce";
import picomatch from "picomatch";
const originEnvelope=z.object({deliveryId:z.string(),appId:z.string(),installationId:z.string().optional(),event:z.object({type:z.string(),payload:z.record(z.unknown())})});
export const replaceGitCredentials=action({args:{token:v.string(),connectionId:v.id("providerConnections"),credential:v.string()},handler:async(ctx,a):Promise<void>=>{
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,{token:a.token,connectionId:a.connectionId});
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 if(!["gitlab","gitea","github-enterprise","bitbucket-dc"].includes(c.kind))throw Error("This provider uses its native installation or ticket renewal flow");
 const raw=a.credential.trim();if(raw.length<10||raw.length>20000)throw Error("Invalid provider credential");
 const selected=await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id});
 const credentials=encryptCredential(raw,c.organizationId+":"+c.kind);
 const available=await discoverRepositories({...c,credentials});
 if(selected.some(r=>!r.externalId||!available.some(candidate=>candidate.externalId===r.externalId&&candidate.fullName===r.fullName)))throw Error("Replacement credential cannot read every selected repository at its registered identity");
 await ctx.runMutation(internal.providerConnections.replaceGitCredentials,{token:a.token,id:c._id,previousCredentials:c.credentials,credentials,repositories:selected.map(r=>({id:r._id,externalId:r.externalId!,fullName:r.fullName}))});
}});
export const refreshP4Ticket=action({args:{token:v.string(),connectionId:v.id("providerConnections"),ticket:v.string()},handler:async(ctx,a):Promise<void>=>{
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,{token:a.token,connectionId:a.connectionId});
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 if(c.kind!=="perforce")throw new Error("P4 connection required");
 const old=p4Credential.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+":perforce")));
 const next=p4Credential.parse({username:old.username,ticket:a.ticket});
 const client=new P4CodeReview(c.instance,next.username,next.ticket);
 // This is renewal of the existing bot, never a switch to a different identity.
 await client.authenticatedIdentity();
 const projects=await client.projects(),repositories=await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id});
 if(repositories.some(r=>!projects.some(p=>p.id===r.externalId)))throw new Error("Renewed P4 bot cannot read every selected project");
 if(next.ticket===old.ticket)return;
 await ctx.runMutation(internal.providerConnections.refreshP4,{token:a.token,id:c._id,previousCredentials:c.credentials,credentials:encryptCredential(JSON.stringify(next),c.organizationId+":perforce"),projectIds:projects.map(p=>p.id)});
}});
export const originWebhook=action({args:{secret:v.string(),body:v.string(),externalId:v.string(),timestamp:v.string(),signature:v.string()},handler:async(ctx,a)=>{
 if(!process.env.SERVICE_SECRET||a.secret!==process.env.SERVICE_SECRET)throw new Error("Unauthorized service");
 if(a.body.length>4000000||!process.env.ORIGIN_APP_ID)throw new Error("Invalid Origin webhook configuration or body");
 if(!await verifyOriginWebhook(a.body,a.externalId,a.timestamp,a.signature))throw new Error("Invalid Origin signature");
 const e=originEnvelope.parse(JSON.parse(a.body));
 if(e.deliveryId!==a.externalId||e.appId!==process.env.ORIGIN_APP_ID)throw new Error("Origin delivery identity mismatch");
 if(e.event.type==="ping")return;
 const installationId=e.installationId??z.object({installation:z.object({id:z.string(),appId:z.string()})}).parse(e.event.payload).installation.id;
 const c=await ctx.runQuery(internal.providerConnections.originInstallation,{installationId});
 if(!c?.active)return;
 if(e.event.type.startsWith("installation.")){
  const p=z.object({installation:z.object({id:z.string(),appId:z.string()})}).parse(e.event.payload);
  if(p.installation.id!==installationId||p.installation.appId!==e.appId)throw new Error("Origin installation identity mismatch");
  await ctx.runMutation(internal.providerConnections.originLifecycle,{id:c._id,eventType:e.event.type});return;
 }
 if(c.suspended)throw new Error("Origin installation suspended");
 await ctx.runMutation(internal.providerConnections.receive,{connectionId:c._id,externalId:e.deliveryId,eventType:e.event.type,body:a.body});
}});
export const activateBitbucket=action({args:{token:v.string(),connectionId:v.id("providerConnections")},handler:async(ctx,a):Promise<void>=>{
 const c=await ctx.runQuery(internal.providerInstalls.bitbucketActivation,{token:a.token,id:a.connectionId});
 // Reuse bound, expiry-checked native discovery before enabling this installation.
 await discoverRepositories(c);
 await ctx.runMutation(internal.providerInstalls.activateBitbucket,{token:a.token,id:c._id,credentials:c.credentials});
}});
export const discover=action({args:{token:v.string(),connectionId:v.id("providerConnections")},handler:async(ctx,a):Promise<{externalId:string;fullName:string;defaultBranch:string;remoteUrl:string;group?:{externalId:string;name:string}}[]>=>{
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,a);
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 return discoverRepositories(c);
}});
export const p4Projects=action({args:{token:v.string(),connectionId:v.id("providerConnections")},handler:async(ctx,a):Promise<P4Project[]>=>{
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,a);
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 if(c.kind!=="perforce")throw new Error("P4 connection required");
 const credential=p4Credential.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+":perforce")));
 return new P4CodeReview(c.instance,credential.username,credential.ticket).projects();
}});
export const p4Reviews=action({args:{token:v.string(),connectionId:v.id("providerConnections"),projectId:v.string(),after:v.optional(v.number())},handler:async(ctx,a):Promise<{project:P4Project;reviews:P4Review[];cursor:number|null}>=>{
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,{token:a.token,connectionId:a.connectionId});
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 if(c.kind!=="perforce")throw new Error("P4 connection required");
 const credential=p4Credential.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+":perforce")));
 const client=new P4CodeReview(c.instance,credential.username,credential.ticket);
 const project=await client.project(a.projectId),page=await client.reviewPage(a.projectId,a.after);
 if(page.reviews.some(r=>!r.projects[project.id].length||new Set(r.projects[project.id]).size!==r.projects[project.id].length||r.projects[project.id].some(id=>!project.branches.some(b=>b.id===id))))throw new Error("P4 review branch identity unavailable");
 return {...page,project};
}});
export const p4ApprovalInspection=action({args:{token:v.string(),connectionId:v.id("providerConnections"),projectId:v.string(),nativeNumber:v.number()},handler:async(ctx,a):Promise<P4ApprovalInspection>=>{
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,{token:a.token,connectionId:a.connectionId});
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 if(c.kind!=="perforce")throw new Error("P4 connection required");
 const credential=p4Credential.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+":perforce")));
 const result=await new P4CodeReview(c.instance,credential.username,credential.ticket).approvalInspection(a.projectId,a.nativeNumber);
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,{token:a.token,connectionId:a.connectionId});
 const latest=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 if(latest.credentials!==c.credentials||latest.instance!==c.instance||latest.kind!==c.kind)throw new Error("P4 connection changed during approval inspection");
 return result;
}});
export const select=action({args:{token:v.string(),connectionId:v.id("providerConnections"),externalIds:v.array(v.string())},handler:async(ctx,a)=>{
 await ctx.runQuery(internal.providerConnections.authorizeAdmin,{token:a.token,connectionId:a.connectionId});
 if(!a.externalIds.length||a.externalIds.length>200)throw new Error("Choose 1–200 repositories");
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 let list;
 if(c.kind==="perforce"){
  const credential=p4Credential.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+":perforce")));
  list=(await new P4CodeReview(c.instance,credential.username,credential.ticket).projects()).map(p=>({externalId:p.id,fullName:p.id,defaultBranch:"",group:{externalId:p.id,name:(p.name.trim()||p.id).slice(0,100)}}));
 }else list=await discoverRepositories(c);
 const repositories=list.filter(r=>a.externalIds.includes(r.externalId));if(repositories.length!==new Set(a.externalIds).size)throw new Error("Selected repository unavailable");
 await ctx.runMutation(internal.providerConnections.select,{token:a.token,connectionId:c._id,repositories});
}});
export const webhook=action({args:{secret:v.string(),connectionId:v.id("providerConnections"),signature:v.string(),externalId:v.string(),eventType:v.optional(v.string()),body:v.string()},handler:async(ctx,a)=>{
 if(!process.env.SERVICE_SECRET||a.secret!==process.env.SERVICE_SECRET)throw new Error("Unauthorized service");
 if(Buffer.byteLength(a.body)>4000000||!a.externalId||a.externalId.length>200)throw new Error("Invalid delivery");
 const c=await ctx.runQuery(internal.providerConnections.data,{id:a.connectionId});
 if(!["gitlab","gitea","github-enterprise","bitbucket-dc"].includes(c.kind))throw new Error("Webhook verifier unavailable");
 const expected=decryptCredential(c.webhookSecret,c.organizationId+":"+c.kind+":webhook");
 const verified=c.kind==="gitlab"?timingSafeEqual(createHash("sha256").update(expected).digest(),createHash("sha256").update(a.signature).digest()):verifyWebhook(a.body,c.kind==="gitea"?"sha256="+a.signature:a.signature,expected);
 if(!verified)throw new Error("Invalid webhook signature");
 const payload=JSON.parse(a.body);
 if(c.kind==="bitbucket-dc"&&(!a.eventType||payload.eventKey!==a.eventType))throw new Error("Bitbucket event header and signed body mismatch");
 await ctx.runMutation(internal.providerConnections.receive,{connectionId:c._id,externalId:a.externalId,body:a.body,eventType:a.eventType});
}});
export const event=internalAction({args:{id:v.id("providerEvents")},handler:async(ctx,a)=>{
 const event=await ctx.runQuery(internal.providerConnections.eventData,a);if(!event||event.status==="completed")return;
 if(!await ctx.runMutation(internal.providerConnections.claimEvent,a))return;
 const observedAt=Date.now();
 try{
  const c=await ctx.runQuery(internal.providerConnections.data,{id:event.connectionId});
  if(c.kind==="origin"){
   const envelope=originEnvelope.parse(JSON.parse(event.body));
   if(envelope.installationId!==c.installationId)throw new Error("Origin event installation mismatch");
   if(envelope.event.type!==event.eventType)throw new Error("Origin stored event type mismatch");
   if(["pull_request.review.submitted","pull_request.review.dismissed"].includes(envelope.event.type)){
    const payload=z.object({pullRequest:z.object({number:z.string().regex(/^\d+$/),repository:z.object({id:z.string()})}),review:z.object({id:z.string().min(1)})}).parse(envelope.event.payload);
    const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===payload.pullRequest.repository.id);
    if(repo?.enabled){const number=Number(payload.pullRequest.number);if(!Number.isSafeInteger(number)||number<1)throw new Error("Unsupported Origin change number");await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});}
   }
   if(/^repository\.check_run\.(created|updated|completed)$/.test(envelope.event.type)){
    const repository=z.object({id:z.string()}),sha=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    const payload=z.object({repository,checkSuite:z.object({id:z.string().min(1),repository,sha}),checkRun:z.object({id:z.string().min(1),repository,sha,checkSuite:z.object({id:z.string().min(1)})})}).parse(envelope.event.payload);
    if(payload.repository.id!==payload.checkSuite.repository.id||payload.repository.id!==payload.checkRun.repository.id||payload.checkSuite.sha!==payload.checkRun.sha||payload.checkSuite.id!==payload.checkRun.checkSuite.id)throw new Error("Origin check event repository, suite or revision mismatch");
    const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===payload.repository.id);
    if(repo?.enabled)await ctx.runMutation(internal.approvals.forRevision,{repositoryId:repo._id,headSha:payload.checkRun.sha});
   }
   if(envelope.event.type==="pull_request.comment.created"){
    const p=z.object({
     pullRequest:z.object({number:z.string().regex(/^\d+$/),repository:z.object({id:z.string()})}),
     comment:z.object({id:z.string(),body:z.string().max(16000),thread:z.object({id:z.string()}),author:z.object({user:z.object({id:z.string()}).optional()})}),
    }).parse(envelope.event.payload);
    const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===p.pullRequest.repository.id),author=p.comment.author.user?.id,number=Number(p.pullRequest.number);
    if(repo?.enabled&&author&&/@openreview\b/i.test(p.comment.body)){
     if(!Number.isSafeInteger(number)||number<1)throw new Error("Unsupported Origin change number");
     const client=await provider(ctx,repo);if(!(client instanceof Origin)||!await client.canReply(repo.fullName,author))throw new Error("Comment author requires Origin repository write access");
     const question=await client.followUp(repo.fullName,number,p.comment.id,author,p.comment.body);if(!question)throw new Error("Origin comment is not an OpenReview question");
     if(/@openreview\s+review(?:\s+again|\s+security)?\b/i.test(p.comment.body)){
      const pr=await client.pullRequest(repo.fullName,number);
      if(pr.state==="open")await ctx.runMutation(internal.conversations.requestReview,{repositoryId:repo._id,prNumber:number,commentId:p.comment.id,author:author,question:p.comment.body,headSha:pr.head.sha,revisionKey:pr.revisionKey,...(/review\s+security/i.test(p.comment.body)?{category:"security"}:{})});
     }else{
      await ctx.scheduler.runAfter(0,internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:number,...question});
     }
    }
   }
   if(envelope.event.type==="repository.pushed"||/^pull_request\.(created|published|reopened|closed|merged|metadata\.updated|head_ref\.pushed|base_ref\.updated|stack_parent\.updated)$/.test(envelope.event.type)){
    const payload=z.object({repository:z.object({id:z.string()}),pullRequest:z.object({number:z.string().regex(/^\d+$/)}).optional()}).parse(envelope.event.payload);
    const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===payload.repository.id);
    if(repo?.enabled){
     if(envelope.event.type==="repository.pushed")await ctx.scheduler.runAfter(0,internal.jobs.index,{repositoryId:repo._id});
     if(payload.pullRequest){
      const number=Number(payload.pullRequest.number);if(!Number.isSafeInteger(number)||number<1)throw new Error("Unsupported Origin change number");
      const pr=await (await provider(ctx,repo)).changeMetadata(repo.fullName,number);
      await ctx.runMutation(internal.pulls.observe,{repositoryId:repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,revisionKey:pr.revisionKey,observedAt});
      await ctx.runMutation(internal.webhooks.lifecycle,{repositoryId:repo._id,prNumber:number,action:pr.state==="open"?"updated":"closed",state:pr.state,observedAt});
      const {settings}=await ctx.runQuery(internal.repositories.data,{repositoryId:repo._id});
      if(pr.state==="open"&&settings.automatic&&(!pr.draft||settings.drafts))await ctx.runMutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:number,headSha:pr.head.sha,revisionKey:pr.revisionKey});
     }
    }
   }
  }else if(c.kind==="bitbucket-cloud"){
   const payload=bitbucketEvent.parse(JSON.parse(event.body));
   if(payload.workspace.uuid!==c.namespaceId||payload.eventType!==event.eventType)throw new Error("Bitbucket event workspace or type mismatch");
   const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId==="{"+payload.repository.uuid+"}");
   if(repo?.enabled){
    if(payload.eventType==="avi:bitbucket:push:repository"){
     if(payload.push?.ref===repo.defaultBranch&&!payload.push.closed&&payload.push.after)await ctx.scheduler.runAfter(0,internal.jobs.index,{repositoryId:repo._id});
    }else{
     const number=payload.pullrequest!.id;
     if(payload.eventType==="avi:bitbucket:updated:pullrequest-reviewer-status"){
      await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});
     }else{
     const client=await provider(ctx,repo);
     if(!(client instanceof BitbucketCloud))throw new Error("Bitbucket Cloud connection mismatch");
     if(payload.eventType==="avi:bitbucket:created:pullrequest-comment"){
      if(!payload.selfGenerated&&payload.actor.type==="user"){
       const question=await client.followUp(repo.fullName,number,payload.comment!.id,payload.actor.uuid!);
       if(question){
        if(!await client.canReply(repo.fullName,question.author))throw new Error("Comment author requires Bitbucket repository write access");
        if(/@openreview\s+review(?:\s+again|\s+security)?\b/i.test(question.question)){
         const pr=await client.pullRequest(repo.fullName,number);
         if(pr.state==="open")await ctx.runMutation(internal.conversations.requestReview,{repositoryId:repo._id,prNumber:number,commentId:question.commentId,author:question.author,question:question.question,headSha:pr.head.sha,revisionKey:pr.revisionKey,...(/review\s+security/i.test(question.question)?{category:"security"}:{})});
        }else await ctx.scheduler.runAfter(0,internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:number,...question});
       }
      }
     }else{
      const pr=await client.changeMetadata(repo.fullName,number);
      await ctx.runMutation(internal.pulls.observe,{repositoryId:repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,revisionKey:pr.revisionKey,observedAt});
      await ctx.runMutation(internal.webhooks.lifecycle,{repositoryId:repo._id,prNumber:number,action:pr.state==="open"?"updated":"closed",state:pr.state,observedAt});
      const {settings}=await ctx.runQuery(internal.repositories.data,{repositoryId:repo._id});
      await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});
      if(pr.state==="open"&&settings.automatic&&(!pr.draft||settings.drafts)&&(payload.eventType==="avi:bitbucket:created:pullrequest"||settings.rereview)&&(!settings.targetBranches.length||picomatch(settings.targetBranches)(pr.base.ref))&&!picomatch(settings.ignoredBranches)(pr.head.ref))await ctx.runMutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:number,headSha:pr.head.sha,revisionKey:pr.revisionKey});
     }
     }
    }
   }
  }else if(c.kind==="bitbucket-dc"){
   const payload=z.object({eventKey:z.string(),repository:z.object({id:z.number()}).optional(),pullRequest:z.object({id:z.number().int().positive(),toRef:z.object({repository:z.object({id:z.number()})})}).optional(),actor:z.object({name:z.string()}).optional(),comment:z.object({id:z.number().int().positive(),text:z.string().max(16000),author:z.object({name:z.string(),active:z.boolean()})}).optional(),commentParentId:z.number().int().positive().optional()}).parse(JSON.parse(event.body));
   const externalId=payload.pullRequest?.toRef.repository.id??payload.repository?.id;
   const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===String(externalId));
   if(repo?.enabled){
    if(payload.eventKey==="repo:refs_changed")await ctx.scheduler.runAfter(0,internal.jobs.index,{repositoryId:repo._id});
    const number=payload.pullRequest?.id;
    if(number&&payload.eventKey.startsWith("pr:reviewer:"))await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});
    else if(number&&payload.eventKey==="pr:deleted"){await ctx.runMutation(internal.webhooks.lifecycle,{repositoryId:repo._id,prNumber:number,action:"closed",state:"closed"});await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});}
    else if(number&&payload.eventKey.startsWith("pr:")){
     const client=await provider(ctx,repo);if(!(client instanceof BitbucketDC))throw new Error("Bitbucket connection mismatch");
     if(payload.eventKey==="pr:comment:added"&&payload.comment?.author.active&&payload.actor?.name===payload.comment.author.name&&/@openreview\b/i.test(payload.comment.text)){
      const author=payload.comment.author.name;
      if(!await client.canReply(repo.fullName,author))throw new Error("Comment author requires Bitbucket repository write access");
      if(/@openreview\s+review(?:\s+again|\s+security)?\b/i.test(payload.comment.text)){
       const pr=await client.pullRequest(repo.fullName,number);
       if(pr.state==="open")await ctx.runMutation(internal.conversations.requestReview,{repositoryId:repo._id,prNumber:number,commentId:payload.comment.id,author:author,question:payload.comment.text,headSha:pr.head.sha,revisionKey:pr.revisionKey,...(/review\s+security/i.test(payload.comment.text)?{category:"security"}:{})});
      }else await ctx.scheduler.runAfter(0,internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:number,commentId:payload.comment.id,author,question:payload.comment.text,inline:payload.commentParentId!==undefined,parentCommentId:payload.commentParentId});
     }else if(!payload.eventKey.startsWith("pr:comment:")){
      const pr=await client.changeMetadata(repo.fullName,number);
      await ctx.runMutation(internal.pulls.observe,{repositoryId:repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,revisionKey:pr.revisionKey,observedAt});
      await ctx.runMutation(internal.webhooks.lifecycle,{repositoryId:repo._id,prNumber:number,action:pr.state==="open"?"updated":"closed",state:pr.state,observedAt});
      await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});
      const {settings}=await ctx.runQuery(internal.repositories.data,{repositoryId:repo._id});
      if(pr.state==="open"&&settings.automatic&&(!pr.draft||settings.drafts)&&(settings.rereview||["pr:opened","pr:reopened"].includes(payload.eventKey)))await ctx.runMutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:number,headSha:pr.head.sha,revisionKey:pr.revisionKey});
     }
    }
   }
  }else if(c.kind==="github-enterprise"){
   const payload=z.object({installation:z.object({id:z.number().int().positive()}),repository:z.object({id:z.number()}).optional(),action:z.string().optional(),ref:z.string().optional(),pull_request:z.object({number:z.number().int().positive()}).optional(),issue:z.object({number:z.number().int().positive(),pull_request:z.unknown().optional()}).optional(),comment:z.object({id:z.number().int().positive(),body:z.string().max(16000),in_reply_to_id:z.number().int().positive().optional(),user:z.object({login:z.string(),type:z.string()})}).optional(),review:z.object({id:z.number().int().positive(),body:z.string().nullable(),user:z.object({login:z.string(),type:z.string()})}).optional()}).parse(JSON.parse(event.body));
   const configuration=z.object({installationId:z.number().int().positive()}).parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+":"+c.kind)));
   if(payload.installation.id!==configuration.installationId)throw new Error("GitHub Enterprise installation mismatch");
   const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===String(payload.repository?.id));
   if(repo?.enabled){
    if(event.eventType==="push"&&payload.ref==="refs/heads/"+repo.defaultBranch)await ctx.scheduler.runAfter(0,internal.jobs.index,{repositoryId:repo._id});
    const number=payload.pull_request?.number??(payload.issue?.pull_request?payload.issue.number:undefined);
    if(number&&["pull_request","pull_request_review"].includes(event.eventType??""))await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});
    if(number&&event.eventType==="pull_request"){
     const pr=await (await provider(ctx,repo)).changeMetadata(repo.fullName,number);
     await ctx.runMutation(internal.pulls.observe,{repositoryId:repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,revisionKey:pr.revisionKey,observedAt});
     await ctx.runMutation(internal.webhooks.lifecycle,{repositoryId:repo._id,prNumber:number,action:pr.state==="open"?"updated":"closed",state:pr.state,observedAt});
     const {settings}=await ctx.runQuery(internal.repositories.data,{repositoryId:repo._id});
     if(["opened","synchronize","reopened","ready_for_review"].includes(payload.action??"")&&pr.state==="open"&&settings.automatic&&(!pr.draft||settings.drafts)&&(payload.action!=="synchronize"||settings.rereview)&&(!settings.targetBranches.length||picomatch(settings.targetBranches)(pr.base.ref))&&!picomatch(settings.ignoredBranches)(pr.head.ref))await ctx.runMutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:number,headSha:pr.head.sha,revisionKey:pr.revisionKey});
    }
    const comment=payload.comment??(event.eventType==="pull_request_review"&&payload.review?.body?{id:-payload.review.id,body:payload.review.body,user:payload.review.user,in_reply_to_id:undefined}:undefined);
    if(number&&["issue_comment","pull_request_review_comment","pull_request_review"].includes(event.eventType??"")&&["created","submitted"].includes(payload.action??"")&&comment?.user.type==="User"&&/@openreview\b/i.test(comment.body)){
     const client=await provider(ctx,repo);
     if(!client.canReply||!await client.canReply(repo.fullName,comment.user.login))throw new Error("Comment author requires GitHub Enterprise repository write access");
     if(/@openreview\s+review(?:\s+again|\s+security)?\b/i.test(comment.body)){
      const pr=await client.pullRequest(repo.fullName,number);
      if(pr.state==="open")await ctx.runMutation(internal.conversations.requestReview,{repositoryId:repo._id,prNumber:number,commentId:comment.id,author:comment.user.login,question:comment.body,headSha:pr.head.sha,revisionKey:pr.revisionKey,...(/review\s+security/i.test(comment.body)?{category:"security"}:{})});
     }else await ctx.scheduler.runAfter(0,internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:number,commentId:comment.id,author:comment.user.login,question:comment.body,inline:event.eventType==="pull_request_review_comment",parentCommentId:comment.in_reply_to_id});
    }
   }
  }else if(c.kind==="gitea"){
   const payload=z.object({repository:z.object({id:z.number()}),action:z.string().optional(),ref:z.string().optional(),pull_request:z.object({number:z.number().int().positive()}).nullish(),number:z.number().int().positive().optional(),issue:z.object({number:z.number().int().positive()}).optional(),is_pull:z.boolean().optional(),sender:z.object({login:z.string()}).optional(),review:z.object({content:z.string().max(16000),type:z.string()}).nullish(),comment:z.object({id:z.number().int().positive(),body:z.string().max(16000),user:z.object({login:z.string()})}).optional()}).parse(JSON.parse(event.body));
   const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===String(payload.repository.id));
   if(repo?.enabled){
    if(event.eventType==="push"&&payload.ref==="refs/heads/"+repo.defaultBranch)await ctx.scheduler.runAfter(0,internal.jobs.index,{repositoryId:repo._id});
    const number=payload.pull_request?.number??payload.number;
    // Approval safety is independent of whether automatic reviews are enabled.
    // Re-read native revision and human decisions rather than trusting event content.
    if(number&&["pull_request","pull_request_sync","pull_request_review","pull_request_review_approved","pull_request_review_rejected","pull_request_review_comment"].includes(event.eventType??""))await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:number});
    if(["pull_request","pull_request_sync"].includes(event.eventType??"")&&number){
     const pr=await (await provider(ctx,repo)).changeMetadata(repo.fullName,number);
     await ctx.runMutation(internal.pulls.observe,{repositoryId:repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,revisionKey:pr.revisionKey,observedAt});
     await ctx.runMutation(internal.webhooks.lifecycle,{repositoryId:repo._id,prNumber:number,action:pr.state==="open"?"updated":"closed",state:pr.state,observedAt});
     const {settings}=await ctx.runQuery(internal.repositories.data,{repositoryId:repo._id});
     if(["opened","reopened","synchronized"].includes(payload.action??"")&&pr.state==="open"&&settings.automatic&&(!pr.draft||settings.drafts)&&(payload.action!=="synchronized"||settings.rereview)&&(!settings.targetBranches.length||picomatch(settings.targetBranches)(pr.base.ref))&&!picomatch(settings.ignoredBranches)(pr.head.ref))await ctx.runMutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:number,headSha:pr.head.sha,revisionKey:pr.revisionKey});
    }
    const timelineComment=["issue_comment","pull_request_comment"].includes(event.eventType??"")&&payload.action==="created"&&payload.is_pull===true&&payload.issue&&payload.pull_request?.number===payload.issue.number&&payload.comment&&payload.sender?.login===payload.comment.user.login&&/@openreview\b/i.test(payload.comment.body);
    const reviewType=payload.review?.type;
    const reviewEvent=(["pull_request_review_comment","pull_request_review_approved","pull_request_review_rejected"].includes(event.eventType??"")&&event.eventType===reviewType||event.eventType==="pull_request_comment"&&reviewType==="pull_request_review_comment")&&payload.action==="reviewed"&&payload.review&&payload.sender&&number&&payload.number===payload.pull_request?.number;
    if(timelineComment||reviewEvent){
     const prNumber=payload.pull_request?.number??payload.number;if(!prNumber||!payload.sender)throw new Error("Gitea conversation change unavailable");
     // Gitea code replies are resolved through native review records when its timeline omits them.
     const client=await provider(ctx,repo),author=payload.sender.login;
     if(!(client instanceof Gitea))throw new Error("Gitea connection mismatch");
     const authorized=await client.canReply(repo.fullName,author);if(!authorized&&timelineComment)throw new Error("Comment author requires Gitea repository write access");
     const questions=authorized?await client.followUps(repo.fullName,prNumber,author,timelineComment?{commentId:payload.comment!.id,body:payload.comment!.body}:{reviewContent:payload.review!.content,state:reviewType==="pull_request_review_approved"?"APPROVED":reviewType==="pull_request_review_rejected"?"REQUEST_CHANGES":"COMMENT"}):[];
     for(const question of questions){
      if(/@openreview\s+review(?:\s+again|\s+security)?\b/i.test(question.body)){
       const pr=await client.pullRequest(repo.fullName,prNumber);
       if(pr.state==="open")await ctx.runMutation(internal.conversations.requestReview,{repositoryId:repo._id,prNumber,commentId:question.commentId,author,question:question.body,headSha:pr.head.sha,...(/review\s+security/i.test(question.body)?{category:"security"}:{})});
      }else await ctx.scheduler.runAfter(0,internal.conversationJobs.reply,{repositoryId:repo._id,prNumber,commentId:question.commentId,author,question:question.body,inline:question.inline,parentCommentId:question.parentCommentId});
     }
    }
   }
  }else{
  const payload=z.object({object_kind:z.string(),project:z.object({id:z.number()}),object_attributes:z.object({iid:z.number().optional()}).passthrough().optional()}).passthrough().parse(JSON.parse(event.body));
  const repo=(await ctx.runQuery(internal.providerConnections.repositories,{connectionId:c._id})).find(r=>r.externalId===String(payload.project.id));
  if(repo?.enabled){
   if(payload.object_kind==="push"&&payload.ref==="refs/heads/"+repo.defaultBranch)await ctx.scheduler.runAfter(0,internal.jobs.index,{repositoryId:repo._id});
   if(payload.object_kind==="note"){
    const p=z.object({user:z.object({id:z.number().int().positive(),username:z.string()}),object_attributes:z.object({id:z.number().int().positive(),note:z.string().max(16000),noteable_type:z.string(),author_id:z.number(),action:z.string(),system:z.boolean(),internal:z.boolean().optional()}),merge_request:z.object({iid:z.number().int().positive(),target_project_id:z.number()}).optional()}).parse(payload);
    const n=p.object_attributes;
    if(n.action==="create"&&n.noteable_type==="MergeRequest"&&!n.system&&!n.internal&&p.merge_request?.target_project_id===payload.project.id&&n.author_id===p.user.id&&/@openreview\b/i.test(n.note)){
     const client=await provider(ctx,repo);if(!(client instanceof Gitlab)||!await client.canReply(repo.fullName,p.user.username))throw new Error("Comment author requires GitLab repository write access");
     const number=p.merge_request.iid,parentCommentId=await client.discussionParent(repo.fullName,number,n.id,p.user.username,n.note);
     if(/@openreview\s+review(?:\s+again|\s+security)?\b/i.test(n.note)){
      const pr=await client.pullRequest(repo.fullName,number);
      if(pr.state==="open")await ctx.runMutation(internal.conversations.requestReview,{repositoryId:repo._id,prNumber:number,commentId:n.id,author:p.user.username,question:n.note,headSha:pr.head.sha,revisionKey:pr.revisionKey,...(/review\s+security/i.test(n.note)?{category:"security"}:{})});
     }else await ctx.scheduler.runAfter(0,internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:number,commentId:n.id,author:p.user.username,question:n.note,inline:true,parentCommentId});
    }
   }
   if(payload.object_kind==="emoji"){
    // Award-emoji webhook: 👍/👎 on an OpenReview finding note becomes reaction feedback.
    const e=z.object({event_type:z.enum(["award","revoke"]),user:z.object({username:z.string()}),object_attributes:z.object({name:z.string(),awardable_type:z.string(),awardable_id:z.number().int().positive()}),merge_request:z.object({iid:z.number().int().positive()}).optional()}).passthrough().parse(JSON.parse(event.body));
    const reaction=e.object_attributes.name==="thumbsup"?"+1" as const:e.object_attributes.name==="thumbsdown"?"-1" as const:undefined;
    if(reaction&&e.object_attributes.awardable_type==="Note"&&e.merge_request)await ctx.runMutation(internal.reactions.emoji,{repositoryId:repo._id,prNumber:e.merge_request.iid,noteId:String(e.object_attributes.awardable_id),user:e.user.username,reaction,award:e.event_type==="award"});
   }
   if(payload.object_kind==="merge_request"&&payload.object_attributes?.iid){
    const attributes=z.object({action:z.string(),oldrev:z.string().nullish()}).parse(payload.object_attributes);
    await ctx.runMutation(internal.approvals.forChange,{repositoryId:repo._id,prNumber:payload.object_attributes.iid});
    const pr=await (await provider(ctx,repo)).changeMetadata(repo.fullName,payload.object_attributes.iid);
    await ctx.runMutation(internal.pulls.observe,{repositoryId:repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,revisionKey:pr.revisionKey,observedAt});
    await ctx.runMutation(internal.webhooks.lifecycle,{repositoryId:repo._id,prNumber:pr.number,action:pr.state==="open"?"updated":"closed",state:pr.state,observedAt});
    const {settings}=await ctx.runQuery(internal.repositories.data,{repositoryId:repo._id});
    if(["open","reopen","update"].includes(attributes.action)&&pr.state==="open"&&settings.automatic&&(!pr.draft||settings.drafts)&&(!attributes.oldrev||settings.rereview)&&(!settings.targetBranches.length||picomatch(settings.targetBranches)(pr.base.ref))&&!picomatch(settings.ignoredBranches)(pr.head.ref))await ctx.runMutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:pr.number,headSha:pr.head.sha,revisionKey:pr.revisionKey});
   }
  }
  }
  await ctx.runMutation(internal.providerConnections.eventState,{...a,status:"completed"});
 }catch(error){await ctx.runMutation(internal.providerConnections.eventState,{...a,status:"failed",error:error instanceof Error?error.message:"Event failed"});}
}});
export const rereview=action({args:{token:v.string(),repositoryId:v.id("repositories"),prNumber:v.number(),expectedRevision:v.optional(v.string()),expectedRevisionKey:v.optional(v.string()),force:v.optional(v.boolean())},handler:async(ctx,a):Promise<Id<"reviews">|null>=>{
 const repo=await ctx.runQuery(internal.providerConnections.reviewAccess,{token:a.token,repositoryId:a.repositoryId});
 if(!Number.isInteger(a.prNumber)||a.prNumber<1)throw new Error("Invalid change number");
 const pr=await (await provider(ctx,repo)).pullRequest(repo.fullName,a.prNumber);
 if(pr.state!=="open")throw new Error("Change is closed");
 if(a.expectedRevision!==undefined&&pr.head.sha!==a.expectedRevision||a.expectedRevisionKey!==undefined&&pr.revisionKey!==a.expectedRevisionKey)throw new Error('Revision changed; refresh the pull request list');
 return ctx.runMutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:a.prNumber,headSha:pr.head.sha,revisionKey:pr.revisionKey,force:a.force??true});
}});
