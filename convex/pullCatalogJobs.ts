"use node";
import {v} from 'convex/values';import {internalAction} from './_generated/server';import {internal} from './_generated/api';import {provider} from './scm';import {validateChangePage,changeMetadataSchema} from '../src/change-metadata';
export const step=internalAction({args:{id:v.id('pullCatalogJobs')},handler:async(ctx,a)=>{
 const leaseId=crypto.randomUUID(),identity={...a,leaseId},state=await ctx.runMutation(internal.pullCatalogs.claim,identity);if(!state)return;
 try{
  const client=await provider(ctx,state.repo),page=validateChangePage(await client.openChanges(state.repo.fullName,state.job.cursor),state.job.cursor);
  const rows=[];
  // Bound native fan-out and avoid any diff, source, or inference requests.
  for(let i=0;i<page.numbers.length;i+=5){
   if(!await ctx.runQuery(internal.pullCatalogs.allowed,identity))throw Error('Import access changed');
   const observedAt=Date.now(),batch=await Promise.all(page.numbers.slice(i,i+5).map(async number=>{const pr=changeMetadataSchema.parse(await client.changeMetadata(state.repo.fullName,number));if(pr.number!==number)throw Error('Native catalog change identity mismatch');return {repositoryId:state.repo._id,number:pr.number,title:pr.title,author:pr.user.login,url:pr.html_url,headSha:pr.head.sha,baseSha:pr.base.sha,state:pr.state,revisionKey:pr.revisionKey,observedAt};}));rows.push(...batch);
  }
  await ctx.runMutation(internal.pullCatalogs.finishPage,{...identity,rows,next:page.next});
 }catch(e){await ctx.runMutation(internal.pullCatalogs.failed,{...identity,error:e instanceof Error?e.message:'Change import failed'});}
}});
