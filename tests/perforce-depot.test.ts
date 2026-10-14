import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,stat,rm} from "node:fs/promises";
import {P4CodeReview} from "../src/perforce";
import {HttpModel} from "../src/engine/model";
import type {ModelRequest} from "../src/engine/types";
import {z} from "zod";
import path from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {indexP4Depot,p4IndexMain,p4ShelfInput} from "../src/perforce-depot";

test("native P4 indexing binds submitted revisions, view exclusions, exact digests and a read-only fixed CLI",async()=>{
 const fetchOriginal=globalThis.fetch,logOriginal=console.log,previousUser=process.env.P4USER,previousTicket=process.env.P4PASSWD,previousHosts=process.env.SCM_ALLOWED_HOSTS,originalGenerate=HttpModel.prototype.generate;
 const directory=await mkdtemp(path.join(tmpdir(),"openreview-p4-fixture-")),previous=process.env.PATH;
 const source="export function cents(price: number) { return price * 100; }\n",billing="import { cents } from './price';\nexport const charge = cents(2);\n";
 const files=[{depotFile:"//depot/main/src/price.ts",content:source},{depotFile:"//depot/main/src/billing.ts",content:billing},{depotFile:"//depot/main/private/secret.ts",content:"private"},{depotFile:"//depot/main/.env",content:"SECRET=private"},{depotFile:"//depot/main/image.png",content:"binary"}].map(f=>({...f,code:"stat",headRev:"3",headChange:"40",headAction:"edit",headType:"text",fileSize:String(Buffer.byteLength(f.content)),digest:createHash("md5").update(f.content).digest("hex")}));
 const modeFile=path.join(directory,"mode.json"),callsFile=path.join(directory,"calls.jsonl");
 const script=`#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict');
const mode=JSON.parse(fs.readFileSync(${JSON.stringify(modeFile)},'utf8')),files=${JSON.stringify(files)},args=process.argv.slice(2);
assert.deepEqual(args.slice(0,4),['-p','ssl:p4.example:1666','-u','bot']);assert.equal(process.env.P4PASSWD,'fixture-ticket');assert.equal(fs.existsSync(process.env.P4TICKETS),false);assert.equal(process.env.P4CONFIG,'');
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');
let command=args[4]==='-Mj'?args[6]:args[4];const row=value=>console.log(JSON.stringify(value));
if(command==='info')row({ServerID:mode==='server'?'wrong':'main',userName:'bot'});
else if(command==='change')row({Change:'42',Status:mode==='pending'?'pending':'submitted'});
else if(command==='fstat'){
 assert.ok(args.at(-1).endsWith('@42'));assert.equal(args.includes('-Os'),true);assert.equal(args.includes('-Ol'),true);assert.equal(args.includes('10001'),true);
 if(mode==='error')row({code:'error',severity:3,data:'permission denied'});
 else if(mode==='limit')for(let i=0;i<10001;i++)row(files[0]);
 else for(const file of files.filter(f=>!args.at(-1).includes('/src/')||f.depotFile.includes('/src/'))){const {content,...record}=file;row({...record,...(mode==='outside'?{depotFile:'//other/secret.ts'}:{}),...(mode==='revision'?{headChange:'43'}:{}),...(mode==='encoding'?{depotFile:'//depot/main/\\uFFFD.ts'}:{})});}
}
else if(command==='print'){
 assert.deepEqual(args.slice(4,-1),['print','-q','-K']);assert.ok(args.at(-1).endsWith('#3'));
 const file=files.find(f=>f.depotFile+'#3'===args.at(-1));assert.ok(file);assert.equal(file.depotFile.includes('/private/'),false);assert.equal(file.depotFile.endsWith('.env'),false);assert.equal(file.depotFile.endsWith('.png'),false);process.stdout.write(mode==='digest'?'changed':file.content);
}else throw new Error('Unexpected native mutation or command');
`;
 try{
  await writeFile(path.join(directory,"p4"),script,{mode:0o700});process.env.PATH=directory+path.delimiter+previous;
  const config={server:"ssl:p4.example:1666",serverId:"main",username:"bot",ticket:"fixture-ticket",change:42},project={id:"payments",name:"Payments",branches:[{id:"main",name:"Main",paths:["//depot/main/...","-//depot/main/private/...","+//depot/main/src/..."]}]};
  await writeFile(modeFile,JSON.stringify("normal"));const result=await indexP4Depot(project,config);
  assert.match(result.revision,/^p4:main:submitted:42:[a-f0-9]{64}$/);assert.equal(result.index.files.length,2);assert.ok(result.index.symbols.some(s=>s.name==='cents'));assert.ok(result.index.relationships.some(r=>r.kind==='imports'));
  assert.deepEqual(result.skipped.map(s=>s.path).sort(),["//depot/main/.env","//depot/main/image.png"]);assert.equal(result.coverage.length,2);
  const calls=(await readFile(callsFile,'utf8')).trim().split('\n').map(v=>JSON.parse(v));assert.equal(calls.filter(a=>a[4]==='print').length,2);assert.equal(JSON.stringify(calls).includes('fixture-ticket'),false);
  for(const [mode,message] of [["server",/identity mismatch/],["pending",/submitted changelist/],["outside",/view mismatch/],["revision",/revision/],["encoding",/replacement/],["error",/Invalid/],["limit",/10,000/],["digest",/digest/]] as const){await writeFile(modeFile,JSON.stringify(mode));await assert.rejects(indexP4Depot(project,config),message);}
  await assert.rejects(indexP4Depot(project,{...config,server:"p4.example:1666"}));await assert.rejects(indexP4Depot({...project,branches:[{id:"main",name:"Main",paths:['//depot/...@forged']}]},config),/views/);
  await writeFile(modeFile,JSON.stringify("normal"));process.env.P4USER="bot";process.env.P4PASSWD="fixture-ticket";process.env.SCM_ALLOWED_HOSTS="p4.example";let projectReads=0,race=false;
  globalThis.fetch=async(input,init)=>{assert.equal(new URL(String(input)).pathname,"/api/v9/projects/payments");assert.equal(init?.redirect,"error");projectReads++;return Response.json({project:race&&projectReads>1?{...project,branches:[{id:"main",name:"Main",paths:["//different/..."]}]}:project});};
  console.log=()=>{};
  const output=path.join(directory,"index.json"),cli=["index","--server",config.server,"--server-id",config.serverId,"--url","https://p4.example","--project",project.id,"--change","42","--output",output];
  await p4IndexMain(cli);assert.equal(projectReads,2);assert.equal((await stat(output)).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(output,"utf8")).index.files.length,2);
  const saved=await readFile(output,"utf8");await assert.rejects(p4IndexMain(cli),/EEXIST/);assert.equal(await readFile(output,"utf8"),saved);
  projectReads=0;race=true;await assert.rejects(p4IndexMain([...cli.slice(0,-1),path.join(directory,"raced.json")]),/view changed/);await assert.rejects(stat(path.join(directory,"raced.json")),/ENOENT/);
  race=false;let shelfChanged=false,badLeft=false,modelCalls=0;
  const nativePath=files[0].depotFile,head=source.replace('price * 100','price / 100'),patch='@@ -1 +1 @@\n-'+source.trimEnd()+'\n+'+head.trimEnd()+'\n';
  let shelfFiles=[{depotFile:nativePath,action:'edit',type:'text',rev:3,fileSize:Buffer.byteLength(head),digest:createHash('md5').update(head).digest('hex')}],viewReads=0;
  const addedPath='//depot/main/src/new.ts',addedSource='export const added = true;\n';
  const nativeReview={id:12,author:'alice',description:'Change currency calculation',updated:1,pending:true,state:'needsReview',projects:{payments:['main']},versions:[{change:43,archiveChange:44,pending:true,time:1}]};
  globalThis.fetch=async(input,init)=>{
   const url=new URL(String(input));assert.equal(url.origin,'https://p4.example');assert.equal(init?.redirect,'error');assert.notEqual(init?.method,'POST');
   assert.equal((init?.headers as Record<string,string>).authorization,'Basic '+Buffer.from('bot:fixture-ticket').toString('base64'));
   if(url.pathname==='/api/v9/projects/payments')return Response.json({project});
   if(url.pathname==='/api/v11/reviews/12')return Response.json({error:null,data:{reviews:[{...nativeReview,versions:[{...nativeReview.versions[0],archiveChange:shelfChanged?45:44}]}]}});
   if(url.pathname==='/api/v11/reviews/12/files')return Response.json({error:null,data:{limited:false,files:shelfFiles}});
   if(url.pathname.endsWith('/diff')){
    const depot=Buffer.from(url.pathname.split('/').at(-2)!,'base64url').toString(),file=shelfFiles.find(f=>f.depotFile===depot)!,added=file.action==='add',deleted=file.action==='delete';
    assert.equal(url.searchParams.get('from'),added?'#0':'#3');assert.equal(url.searchParams.get('to'),'@=44');
    const changed=added?'@@ -0,0 +1 @@\n+'+addedSource.trimEnd()+'\n':deleted?'@@ -1,2 +0,0 @@\n'+billing.trimEnd().split('\n').map(l=>'-'+l).join('\n')+'\n':badLeft?patch.replace('-'+source.trimEnd(),'-invented baseline'):patch;
    return Response.json({error:null,data:{isCut:false,isSame:false,header:`--- a/${added?'dev/null':depot+'#3'}\n+++ b/${deleted?'dev/null':depot+'@=44'}\n`,diffs:[changed],paging:{diffs:1,offset:null}}});
   }
   if(url.pathname.startsWith('/api/v11/files/')){const depot=Buffer.from(url.pathname.split('/').at(-1)!,'base64url').toString();return Response.json({error:null,data:{filename:depot,fileRevision:'@=44',contentLink:'https://p4.example/view/'+depot.slice(2)}});}
   if(url.pathname.startsWith('/view/')){viewReads++;return new Response(url.pathname==='/view/'+nativePath.slice(2)?head:addedSource);}
   throw new Error('Unexpected native review request '+url.pathname);
  };
  const client=new P4CodeReview('https://p4.example','bot','fixture-ticket'),shelf=await p4ShelfInput(client,project.id,12,config);
  assert.match(shelf.input.headSha,/^p4:12:1:44:/);assert.match(shelf.input.baseSha,/^p4:main:submitted:42:/);
  assert.deepEqual(shelf.input.files.map(f=>f.path),['depot/main/src/billing.ts','depot/main/src/price.ts']);
  assert.equal(shelf.input.files.find(f=>f.path.endsWith('price.ts'))!.content,head);assert.equal(shelf.input.files.find(f=>f.path.endsWith('billing.ts'))!.content,billing);
  assert.equal(shelf.input.diff[0].path,'depot/main/src/price.ts');assert.equal(shelf.input.coverageLimits!.length,3);
  badLeft=true;await assert.rejects(p4ShelfInput(client,project.id,12,config),/left side/);badLeft=false;
  const originalShelfFiles=shelfFiles;
  shelfFiles=[{depotFile:addedPath,action:'add',type:'text',rev:0,fileSize:Buffer.byteLength(addedSource),digest:createHash('md5').update(addedSource).digest('hex')}];
  const added=await p4ShelfInput(client,project.id,12,config);assert.equal(added.input.files.length,3);assert.equal(added.input.diff[0].status,'added');assert.equal(added.input.files.find(f=>f.path===addedPath.slice(2))!.content,addedSource);
  shelfFiles=[{depotFile:files[1].depotFile,action:'delete',type:'text',rev:3,fileSize:0,digest:createHash('md5').update('').digest('hex')}];
  const deleted=await p4ShelfInput(client,project.id,12,config);assert.deepEqual(deleted.input.files.map(f=>f.path),[nativePath.slice(2)]);assert.equal(deleted.input.diff[0].status,'removed');
  shelfFiles=[{...originalShelfFiles[0],action:'add'}];await assert.rejects(p4ShelfInput(client,project.id,12,config),/selected readable baseline/);
  shelfFiles=[{...originalShelfFiles[0],type:'binary'}];const readsBefore=viewReads,excluded=await p4ShelfInput(client,project.id,12,config);assert.equal(viewReads,readsBefore);assert.equal(excluded.input.diff.length,0);assert.equal(excluded.input.files.some(f=>f.path===nativePath.slice(2)),false);assert.match(excluded.input.coverageLimits!.at(-1)!,/unsupported source type/);
  shelfFiles=[{...originalShelfFiles[0],depotFile:'//depot/main/.env'}];await p4ShelfInput(client,project.id,12,config);assert.equal(viewReads,readsBefore);
  shelfFiles=originalShelfFiles;

  nativeReview.state='approved';await assert.rejects(p4ShelfInput(client,project.id,12,config),/open archived/);nativeReview.state='needsReview';
  nativeReview.versions[0].pending=false;await assert.rejects(p4ShelfInput(client,project.id,12,config),/open archived/);nativeReview.versions[0].pending=true;
  let raceDuringInference=false;
  HttpModel.prototype.generate=async function<T>(request:ModelRequest,validator:z.ZodType<T>){
   modelCalls++;
   const input=(request.context??request.input) as {context:{path:string;content:string}[];baseSha:string;headSha:string};
   assert.ok(input.context.some(f=>f.path.endsWith('billing.ts')));assert.ok(input.context.some(f=>f.path.endsWith('price.ts')&&f.content.includes('price / 100')));assert.equal(input.headSha,shelf.input.headSha);assert.equal(input.baseSha,shelf.input.baseSha);
   const candidate={title:'Currency calculation undercharges billing',description:'Dividing by 100 returns dollars where the billing caller requires integer cents.',severity:'high',confidence:1,category:'correctness',filePath:'depot/main/src/price.ts',startLine:1,endLine:1,evidence:[{filePath:'depot/main/src/price.ts',startLine:1,quote:head.trimEnd()},{filePath:'depot/main/src/billing.ts',startLine:2,quote:billing.split('\n')[1]}],impact:'Billing uses the wrong currency units.',suggestedFix:'Multiply price by 100 to preserve integer cents.',symbol:'cents'};
   const value=request.task.startsWith('review:')?{findings:request.task==='review:correctness'?[candidate]:[]}:request.task==='verify'?{decisions:[{index:0,publish:true,confidence:1,reason:'The pinned shelf and billing caller use incompatible currency units.'}]}:{summary:'The shelf changes currency calculation in a way incompatible with the unchanged billing caller.',reviewScore:{value:2,reason:'The verified currency conversion defect requires correction before merging.'}};
   if(raceDuringInference)shelfChanged=true;
   return {value:validator.parse(value),usage:{task:request.task,provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,latencyMs:0,estimatedCost:0,cached:false}};
  };
  const reviewPath=path.join(directory,'review.json'),reviewArgs=['review',...cli.slice(1,-1),reviewPath,'--review','12'];
  await p4IndexMain(reviewArgs);const reviewed=JSON.parse(await readFile(reviewPath,'utf8'));assert.equal(reviewed.result.findings.length,1);assert.equal(reviewed.result.findings[0].commitSha,shelf.input.headSha);assert.equal(reviewed.result.metadata.reviewScore.value,2);assert.equal((await stat(reviewPath)).mode&0o777,0o600);assert.equal(JSON.stringify(reviewed).includes('fixture-ticket'),false);
  const callsBefore=modelCalls;await assert.rejects(p4IndexMain(reviewArgs),/EEXIST/);assert.equal(modelCalls,callsBefore);
  await assert.rejects(p4IndexMain([...reviewArgs,'--mode','unknown']));assert.equal(modelCalls,callsBefore);
  raceDuringInference=true;const racedReview=path.join(directory,'raced-review.json');await assert.rejects(p4IndexMain(['review',...cli.slice(1,-1),racedReview,'--review','12']),/shelf changed during inference/);await assert.rejects(stat(racedReview),/ENOENT/);

 }finally{globalThis.fetch=fetchOriginal;console.log=logOriginal;HttpModel.prototype.generate=originalGenerate;for(const [name,value] of [["P4USER",previousUser],["P4PASSWD",previousTicket],["SCM_ALLOWED_HOSTS",previousHosts]]){if(value===undefined)delete process.env[name!];else process.env[name!]=value;}
 if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;await rm(directory,{recursive:true,force:true});}
});
