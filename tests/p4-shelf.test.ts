import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {P4CodeReview} from '../src/perforce';
import {p4ShelfFromIndex} from '../src/p4-shelf';
import {p4SubmittedInventory} from '../src/p4-index';
import {p4FixManifest} from '../src/p4-fix-manifest';

test('P4 moves overlay deletion and addition against pinned context and reject missing or conflicting baselines',async()=>{
 const previousFetch=globalThis.fetch,previousHosts=process.env.SCM_ALLOWED_HOSTS;process.env.SCM_ALLOWED_HOSTS='p4.example';
 const old='//depot/main/old.ts',added='//depot/main/new.ts',caller='//depot/main/caller.ts',source='export const cents = 199;\n',callerSource="import { cents } from './old';\nexport const charge = cents * 2;\n";
 const digest=(s:string)=>createHash('md5').update(s).digest('hex');
 const project={id:'payments',name:'Payments',branches:[{id:'main',name:'Main',paths:['//depot/main/...']}]};
 const inventory=p4SubmittedInventory({project,serverId:'native',change:5,manifest:[{depotFile:old,content:source},{depotFile:caller,content:callerSource}].map(f=>({code:'stat',depotFile:f.depotFile,headRev:1,headChange:5,headAction:'add',headType:'text',fileSize:Buffer.byteLength(f.content),digest:digest(f.content)}))});
 const files=[{path:old.slice(2),content:source},{path:caller.slice(2),content:callerSource}].map(f=>({...f,sha:'p4:native:1:'+digest(f.content),size:Buffer.byteLength(f.content)}));
 const review={id:14,author:'author',description:'Move price implementation',updated:1,pending:true,state:'needsReview',projects:{payments:['main']},versions:[{change:13,archiveChange:15,pending:true,time:1}]};
 const nativeFiles=[{depotFile:old,action:'move/delete',type:'text',rev:1},{depotFile:added,action:'move/add',type:'text',rev:1,fileSize:Buffer.byteLength(source),digest:digest(source)}];
 const reads:string[]=[];let deletionRightCount=1,partialDeletion=false;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));assert.equal(init?.redirect,'error');assert.equal(u.origin,'https://p4.example');reads.push(u.pathname);
  if(u.pathname==='/api/v9/projects/payments')return Response.json({project});
  if(u.pathname==='/api/v11/reviews/14')return Response.json({error:null,data:{reviews:[review]}});
  if(u.pathname==='/api/v11/reviews/14/files')return Response.json({error:null,data:{limited:false,files:nativeFiles}});
  if(u.pathname.startsWith('/api/v11/files/')){
   const path=Buffer.from(u.pathname.split('/')[4],'base64url').toString();assert.ok([old,added].includes(path));
   if(u.pathname.endsWith('/diff')){
    const isAdded=path===added;assert.equal(u.searchParams.get('from'),isAdded?'#0':'#1');assert.equal(u.searchParams.get('to'),'@=15');
    if(!isAdded&&partialDeletion)return Response.json({error:null,data:{isCut:false,isSame:true,header:`--- a/${old}#1\n+++ b/dev/null\n`,diffs:[],paging:{diffs:0,offset:null}}});
    return Response.json({error:null,data:{isCut:false,isSame:false,header:`--- a/${isAdded?'dev/null':old+'#1'}\n+++ b/${isAdded?added+'@=15':'dev/null'}\n`,diffs:[isAdded?'@@ -0,0 +1 @@\n+'+source:`@@ -1 +0,${deletionRightCount} @@\n-`+source],paging:{diffs:1,offset:null}}});
   }
   assert.equal(path,added);assert.equal(u.searchParams.get('fileRevision'),'@=15');return Response.json({error:null,data:{filename:added,fileRevision:'@=15',contentLink:'https://p4.example/view/'+added.slice(2)}});
  }
  if(u.pathname==='/view/'+added.slice(2)){assert.equal(u.searchParams.get('v'),'@=15');return new Response(source);}
  throw Error('Unexpected native request: '+u.pathname);
 };
 try{
  const client=new P4CodeReview('https://p4.example','bot','fixture-ticket');
  const result=await p4ShelfFromIndex(client,'payments',14,{inventory,files,coverage:[]});
  assert.deepEqual(result.input.diff.map(f=>[f.path,f.status]),[[old.slice(2),'removed'],[added.slice(2),'added']]);
  assert.deepEqual(result.baseRevisions,{[old]:1,[added]:0});
  assert.deepEqual(result.input.files.map(f=>f.path).sort(),[caller.slice(2),added.slice(2)].sort());assert.equal(result.input.files.find(f=>f.path===caller.slice(2))!.content,callerSource);
  const snapshot=await client.snapshot('payments',14);const manifest=p4FixManifest(inventory,files,snapshot);
  assert.deepEqual(manifest.filter(f=>f.nativeAction).map(f=>[f.nativeAction,f.haveRevision]),[['move/delete',1],['move/add',0]]);
  assert.equal(reads.includes('/view/'+old.slice(2)),false);
  deletionRightCount=2;await assert.rejects(p4ShelfFromIndex(client,'payments',14,{inventory,files,coverage:[]}),/hunk line range/);deletionRightCount=1;
  partialDeletion=true;await assert.rejects(p4ShelfFromIndex(client,'payments',14,{inventory,files,coverage:[]}),/complete indexed baseline/);partialDeletion=false;
  await assert.rejects(p4ShelfFromIndex(client,'payments',14,{inventory,files:files.filter(f=>f.path!==old.slice(2)),coverage:[]}),/readable baseline/);
  const conflict=p4SubmittedInventory({project,serverId:inventory.serverId,change:inventory.change,manifest:[...inventory.manifest,{...inventory.manifest[0],depotFile:added}]});
  await assert.rejects(p4ShelfFromIndex(client,'payments',14,{inventory:conflict,files,coverage:[]}),/readable baseline/);
 }finally{globalThis.fetch=previousFetch;if(previousHosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=previousHosts;}
});
