import test from "node:test";
import assert from "node:assert/strict";
import { BitbucketDC } from "../src/bitbucket-dc";
import type { Finding } from "../src/engine/types";
import {gzipSync} from "node:zlib";

const head="b".repeat(40),base="a".repeat(40),target="c".repeat(40),repo="ACME/payments";
const author={name:"alice",active:true,type:"NORMAL"},bot={name:"openreview",active:true,type:"SERVICE"};
const page=(values:unknown[])=>({values,isLastPage:true});
const pr=()=>({id:1,title:"Cents",description:"Fix units",draft:false,state:"OPEN",author:{user:author},fromRef:{displayId:"feature",latestCommit:head,repository:{id:72}},toRef:{displayId:"main",latestCommit:target,repository:{id:71}}});
const change={path:{components:["src","price.ts"]},type:"MODIFY",nodeType:"FILE"};
const nativeDiff=()=>({truncated:false,diffs:[{source:change.path,destination:change.path,binary:false,truncated:false,hunks:[{sourceLine:1,sourceSpan:1,destinationLine:1,destinationSpan:1,segments:[{type:"REMOVED",lines:[{line:"return price;"}]},{type:"ADDED",lines:[{line:"return price / 100;"}]}]}]}]});
const finding:Finding={title:"Wrong cents unit",description:"The payment provider expects an integer amount in cents.",severity:"high",confidence:1,category:"correctness",filePath:"src/price.ts",startLine:1,endLine:1,evidence:[{filePath:"src/price.ts",startLine:1,quote:"return price / 100;"}],impact:"Undercharges customers",suggestedFix:"Return the integer cents value",symbol:"amount",fingerprint:"fixture-cents",agent:"correctness",commitSha:head};

test("Bitbucket author proof excludes service, inactive and unspecified principals and detects ingestion identity races",async t=>{
 let native={...pr(),author:{user:{...author,id:9}}},reads=0,mutate:((value:typeof native)=>typeof native)|undefined;
 t.mock.method(globalThis,"fetch",async(raw:string)=>{
  const p=new URL(raw).pathname;
  if(p.endsWith("/pull-requests/1")){reads++;return Response.json(mutate&&reads%2===0?mutate(native):native);}
  if(p.endsWith("/merge-base"))return Response.json({id:base});
  return Response.json(page([]));
 });
 const client=new BitbucketDC("https://bitbucket.example","fixture-token","71","openreview");
 assert.equal((await client.pullRequest(repo,1)).authorExternalId,"9");
 for(const identity of [{...author,id:9,type:"SERVICE"},{...author,id:9,active:false},{...author,id:9,type:"UNKNOWN"},{...author,id:9,type:undefined}]){
  native={...pr(),author:{user:identity as typeof native.author.user}};assert.equal((await client.pullRequest(repo,1)).authorExternalId,undefined);
 }
 native={...pr(),author:{user:{...author,id:9}}};
 const mutations:((value:typeof native)=>typeof native)[]=[value=>({...value,author:{user:{...value.author.user,id:10}}}),value=>({...value,author:{user:{...value.author.user,name:"renamed"}}}),value=>({...value,author:{user:{...value.author.user,type:"SERVICE"}}}),value=>({...value,draft:true}),value=>({...value,fromRef:{...value.fromRef,repository:{id:73}}}),value=>({...value,toRef:{...value.toRef,displayId:"another-target"}})];
 for(mutate of mutations){
  reads=0;await assert.rejects(client.pullRequest(repo,1),/author or reviewer decisions changed/);
 }
});

test("Bitbucket native reviewer decisions retain reviewed commits and reject contradictory, unpinned or racing metadata",async t=>{
 const reviewer={user:{...author,id:10},role:"REVIEWER",status:"NEEDS_WORK",approved:false,lastReviewedCommit:head};
 let reviewers:Record<string,unknown>[]=[reviewer],participants:Record<string,unknown>[]=[reviewer],reads=0,race=false;
 t.mock.method(globalThis,"fetch",async(raw:string)=>{
  const p=new URL(raw).pathname;
  if(p.endsWith("/pull-requests/1")){reads++;return Response.json({...pr(),reviewers:race&&reads%2===0?[{...reviewer,status:"UNAPPROVED"}]:reviewers,participants:race&&reads%2===0?[]:participants});}
  if(p.endsWith("/merge-base"))return Response.json({id:base});
  return Response.json(page([]));
 });
 const client=new BitbucketDC("https://bitbucket.example","fixture-token","71","openreview");
 const value=await client.pullRequest(repo,1);assert.deepEqual(value.reviews,[{id:"participant:10",body:null,commit_id:head,state:"CHANGES_REQUESTED",user:{login:"alice",type:"User"}}]);assert.equal(client.supportsApproval,true);
 reviewers=[{...reviewer,status:"APPROVED",approved:true,lastReviewedCommit:base}];participants=[];
 assert.equal((await client.pullRequest(repo,1)).reviews[0].commit_id,base);assert.equal((await client.pullRequest(repo,1)).reviews[0].state,"APPROVED");
 for(const invalid of [{...reviewer,approved:true},{...reviewer,lastReviewedCommit:undefined},{...reviewer,status:"UNKNOWN"}]){reviewers=[invalid];await assert.rejects(client.pullRequest(repo,1));}
 reviewers=[reviewer];participants=[{...reviewer,status:"UNAPPROVED"}];await assert.rejects(client.pullRequest(repo,1),/decision is inconsistent/);
 participants=[reviewer];race=true;reads=0;await assert.rejects(client.pullRequest(repo,1),/reviewer decisions changed/);
});

test("Bitbucket runtime archives pin the immutable commit, native repository and authenticated publisher",async t=>{
 const bytes=gzipSync('native archive bytes'),calls:string[]=[];
 t.mock.method(globalThis,'fetch',async(raw:string,options:RequestInit)=>{
  const url=new URL(raw);calls.push(url.pathname);assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).get('authorization'),'Bearer fixture-token');
  if(url.pathname.endsWith('/archive')){assert.equal(url.searchParams.get('at'),head);assert.equal(url.searchParams.get('format'),'tar.gz');assert.equal(url.searchParams.get('prefix'),'openreview/');assert.equal(url.searchParams.has('path'),false);return new Response(bytes,{headers:{'x-ausername':'openreview','content-length':String(bytes.length)}});}
  return Response.json({id:71});
 });
 const source=await new BitbucketDC('https://bitbucket.example/bitbucket','fixture-token','71','openreview').archive(repo,head);assert.deepEqual(source,new Uint8Array(bytes));assert.equal(calls.length,3);assert.ok(calls.every(path=>path.startsWith('/bitbucket/rest/api/latest/projects/ACME/repos/payments')));
 await assert.rejects(new BitbucketDC('https://bitbucket.example','fixture-token','71','openreview').archive(repo,'main'),/exact Git commit/);
 await assert.rejects(new BitbucketDC('https://bitbucket.example','fixture-token').archive(repo,head),/identities/);assert.equal(calls.length,3);
});

test("Bitbucket runtime archives reject missing publishers, invalid bytes, missing bodies and changed native repositories",async t=>{
 const native=new BitbucketDC('https://bitbucket.example','fixture-token','71','openreview');let mode='denied',reads=0;
 t.mock.method(globalThis,'fetch',async(raw:string)=>{
  if(!new URL(raw).pathname.endsWith('/archive'))return Response.json({id:mode==='changed'&&++reads===2?72:71});
  if(mode==='denied')return new Response('',{status:403});
  if(mode==='missing-publisher')return new Response(gzipSync('archive'));
  if(mode==='foreign-publisher')return new Response(gzipSync('archive'),{headers:{'x-ausername':'another-user'}});
  return new Response(mode==='missing-body'?null:mode==='wrong-format'?'not gzip':gzipSync('archive'),{headers:{'x-ausername':'openreview',...(mode==='wrong-size'?{'content-length':'1'}:{})}});
 });
 for(mode of ['denied','missing-publisher','foreign-publisher','wrong-format','missing-body','wrong-size','changed']){reads=0;await assert.rejects(native.archive(repo,head));}
});

test("Bitbucket runtime archive limits cancel oversized headers and streaming bodies",async t=>{
 const native=new BitbucketDC('https://bitbucket.example','fixture-token','71','openreview');let streamed=false,cancelled=false,reads=0,length:string|undefined='20000001';
 t.mock.method(globalThis,'fetch',async(raw:string)=>{
  if(!new URL(raw).pathname.endsWith('/archive'))return Response.json({id:71});
  const body=new ReadableStream<Uint8Array>({pull(controller){reads++;if(streamed)controller.enqueue(new Uint8Array(1000000));else controller.enqueue(new Uint8Array([0x1f,0x8b]));},cancel(){cancelled=true;}});
  return new Response(body,{headers:{'x-ausername':'openreview',...(length===undefined?{}:{'content-length':length})}});
 });
 for(length of ['20000001','NaN','-1','1.5']){cancelled=false;await assert.rejects(native.archive(repo,head),/size invalid/);assert.equal(cancelled,true);}
 length=undefined;streamed=true;reads=0;cancelled=false;await assert.rejects(native.archive(repo,head),/exceeds 20 MB/);assert.equal(cancelled,true);assert.ok(reads<=22);
});

test("Bitbucket native discovery, indexing, diff anchors and publication replay keep exact repository/revision identities",async t=>{
 const notes:unknown[]=[],posts:Record<string,unknown>[]=[];
 let current=pr();
 t.mock.method(globalThis,"fetch",async(raw:string,options:RequestInit)=>{
  const url=new URL(raw),p=url.pathname.replace("/bitbucket/rest/api/latest","");
  assert.equal(options.redirect,"error");assert.equal(new Headers(options.headers).get("authorization"),"Bearer fixture-token");
  if(p==="/repos")return Response.json(page([{id:71,slug:"payments",project:{key:"ACME"},scmId:"git",links:{clone:[{name:"http",href:"https://bitbucket.example/bitbucket/scm/ACME/payments.git"}]}}]));
  if(p.endsWith("/default-branch"))return Response.json({displayId:"main"});
  if(p.endsWith("/repos/payments"))return Response.json({id:71});
  if(p.endsWith("/branches"))return Response.json(page([{displayId:"main",latestCommit:target}]));
  if(p.endsWith("/files"))return Response.json(page(["src/price.ts"]));
  if(p.endsWith("/last-modified/src"))return Response.json({files:{"price.ts":{id:base}}});
  if(p.includes("/raw/"))return new Response("return price / 100;",{headers:{"content-type":"text/plain"}});
  if(url.pathname.includes("/rest/build-status/latest/"))return Response.json(page([{key:"test",state:"FAILED"}]));
  if(p.endsWith("/pull-requests/1"))return Response.json(current);
  if(p.endsWith("/merge-base"))return Response.json({id:base});
  if(p.endsWith("/changes"))return Response.json(page([change]));
  if(p.includes("/diff/"))return Response.json(nativeDiff());
  if(p.endsWith("/commits"))return Response.json(page([{id:head}]));
  if(p.endsWith("/activities"))return Response.json(page(notes.map(comment=>({comment}))));
  if(p.endsWith("/comments")&&options.method==="POST"){
   const body=JSON.parse(String(options.body)),id=notes.length+1;posts.push(body);notes.push({id,...body,...(body.anchor?{anchor:{...body.anchor,path:{components:body.anchor.path.split("/")}}}:{}),author:bot});return Response.json({id,author:bot});
  }
  throw new Error("Unexpected endpoint "+p);
 });
 const client=new BitbucketDC("https://bitbucket.example/bitbucket","fixture-token","71","openreview");
 assert.equal((await client.repositories())[0].externalId,"71");assert.equal(await client.head(repo,"main"),target);
 assert.equal((await client.tree(repo,head))[0].path,"src/price.ts");assert.equal((await client.tree(repo,"d".repeat(40)))[0].sha,base);assert.equal((await client.blob(repo,"src/price.ts",head)).content,"return price / 100;");
 const result=await client.pullRequest(repo,1);assert.equal(result.base.sha,base);assert.equal(result.revisionKey,target);assert.equal(result.checks[0].conclusion,"failure");assert.ok(result.diff[0].patch.includes("+return price / 100;"));
 notes.push({id:99,text:"<!-- openreview:review-1 -->\n<!-- openreview-finding:fixture-cents -->",author,anchor:{path:change.path,toHash:head,line:1}});
 await client.publish(repo,1,head,"Found a units defect",[finding],"review-1","detailed",target);
 assert.deepEqual(posts[0].anchor,{diffType:"RANGE",fromHash:base,toHash:head,path:"src/price.ts",line:1,lineType:"ADDED",fileType:"TO"});
 assert.equal(posts.length,2);
 assert.equal((await client.publish(repo,1,head,"Found a units defect",[finding],"review-1","detailed",target)).reused,true);assert.equal(posts.length,2);
 await assert.rejects(client.publish(repo,1,head,"Summary",[{...finding,startLine:2,endLine:2}],"review-2","detailed",target),/added line/);
 current={...current,fromRef:{...current.fromRef,latestCommit:"d".repeat(40)}};
 await assert.rejects(client.publish(repo,1,head,"Summary",[],"review-2","detailed",target),/revision changed/);assert.equal(posts.length,2);
 assert.equal(client.sourceUrl(repo,head,"src/price.ts"),"https://bitbucket.example/bitbucket/projects/ACME/repos/payments/browse/src/price.ts?at="+head);
});

test("Bitbucket native effective permission lookup pages completely and fails closed on incomplete or unauthorized responses",async t=>{
 let mode="inherited",calls=0;
 t.mock.method(globalThis,"fetch",async(raw:string)=>{
  const url=new URL(raw);calls++;
  if(url.pathname.endsWith("/repos/payments"))return Response.json({id:71});
  assert.ok(url.pathname.endsWith("/users"));
  assert.equal(url.searchParams.get("permission"),"REPO_WRITE");assert.equal(url.searchParams.get("permission.projectKey"),"ACME");assert.equal(url.searchParams.get("permission.repositorySlug"),"payments");
  if(mode==="denied")return new Response(null,{status:403});
  if(mode==="revoked")return Response.json(page([]));
  if(mode==="missing")return Response.json(page([{name:"alice",active:true}]));
  if(mode==="stalled")return Response.json({values:[author],isLastPage:false,nextPageStart:0});
  if(mode==="malformed")return Response.json({values:[author]});
  if(url.searchParams.get("start")==="0")return Response.json({values:[{...author,name:"alice-other"}],isLastPage:false,nextPageStart:7});
  assert.equal(url.searchParams.get("start"),"7");return Response.json(page([author]));
 });
 const client=new BitbucketDC("https://bitbucket.example","fixture","71","openreview");
 assert.equal(await client.canReply(repo,"alice"),true);assert.equal(calls,3);
 mode="revoked";assert.equal(await client.canReply(repo,"alice"),false);
 mode="missing";assert.equal(await client.canReply(repo,"alice"),false);
 mode="stalled";await assert.rejects(client.canReply(repo,"alice"),/did not advance/);
 mode="malformed";await assert.rejects(client.canReply(repo,"alice"));
 mode="denied";await assert.rejects(client.canReply(repo,"alice"),/403/);
 const before=calls;for(const name of ["openreview","","\n","a".repeat(256)])assert.equal(await client.canReply(repo,name),false);assert.equal(calls,before);
 await assert.rejects(client.canReply("../payments","alice"),/Invalid Bitbucket repository/);
});

test("Bitbucket stops on truncated inventory, malformed hunks, changed repository identity and stuck pagination",async t=>{
 let mode="inventory";
 t.mock.method(globalThis,"fetch",async(raw:string)=>{
  const p=new URL(raw).pathname;
  if(p.endsWith("/repos/payments"))return Response.json({id:mode==="identity"?99:71});
  if(p.endsWith("/files"))return Response.json(mode==="missing"?page(["toString"]):{values:["a.ts"],isLastPage:false,nextPageStart:0});
  if(p.endsWith("/last-modified"))return Response.json({files:{}});
  if(p.includes("/raw/")){if(mode==="large")return new Response(new Uint8Array(200001));if(mode==="binary")return new Response(new Uint8Array([255,254]));throw new TypeError("Network interrupted");}
  if(p.endsWith("/pull-requests/1"))return Response.json(pr());
  if(p.endsWith("/merge-base"))return Response.json({id:base});
  if(p.endsWith("/changes"))return Response.json({...page([change]),isLastPage:mode!=="inventory"});
  if(p.includes("/diff/")){
   const d=nativeDiff();if(mode==="truncated")d.diffs[0].truncated=true;else if(mode==="hunk")d.diffs[0].hunks[0].destinationSpan=2;
   return Response.json(d);
  }
  return Response.json(page([]));
 });
 const client=new BitbucketDC("https://bitbucket.example","fixture-token","71","openreview");
 await assert.rejects(client.pullRequest(repo,1));mode="truncated";await assert.rejects(client.pullRequest(repo,1),/truncated/);mode="hunk";await assert.rejects(client.pullRequest(repo,1),/hunk coverage/);
 mode="identity";await assert.rejects(client.tree(repo,head),/identity changed/);
 mode="paging";await assert.rejects(client.tree(repo,head),/did not advance/);
 mode="missing";await assert.rejects(client.tree(repo,head),/source coverage incomplete/);
 mode="large";assert.equal((await client.blob(repo,"a.ts",head)).size,200001);mode="binary";assert.equal((await client.blob(repo,"a.ts",head)).content,"\0");mode="network";await assert.rejects(client.blob(repo,"a.ts",head),/Network interrupted/);
 await assert.rejects(client.head("../payments","main"),/Invalid Bitbucket repository/);
});

test("Bitbucket effective permission filters require an exact active normal author and native replies retain parent IDs",async t=>{
 let permission="REPO_READ",name="alice",active=true,type="NORMAL",post:unknown;
 t.mock.method(globalThis,"fetch",async(raw:string,options:RequestInit)=>{
  const p=new URL(raw).pathname;
  if(p.endsWith("/repos/payments"))return Response.json({id:71});
  if(p.endsWith("/users")){const query=new URL(raw).searchParams;assert.equal(query.get("filter"),"alice");assert.equal(query.get("permission"),"REPO_WRITE");assert.equal(query.get("permission.projectKey"),"ACME");assert.equal(query.get("permission.repositorySlug"),"payments");return Response.json(page(["REPO_WRITE","REPO_ADMIN"].includes(permission)?[{...author,name,active,type}]:[]));}
  if(p.endsWith("/pull-requests/1"))return Response.json(pr());
  if(p.endsWith("/activities"))return Response.json(page([]));
  if(options.method==="POST"){post=JSON.parse(String(options.body));return Response.json({id:5});}
  throw new Error("Unexpected endpoint");
 });
 const client=new BitbucketDC("https://bitbucket.example","fixture-token","71","openreview");
 assert.equal(await client.canReply(repo,"alice"),false);permission="REPO_WRITE";assert.equal(await client.canReply(repo,"alice"),true);
 name="alice-other";assert.equal(await client.canReply(repo,"alice"),false);name="alice";active=false;assert.equal(await client.canReply(repo,"alice"),false);
 active=true;type="SERVICE";assert.equal(await client.canReply(repo,"alice"),false);type="UNKNOWN";assert.equal(await client.canReply(repo,"alice"),false);
 assert.equal(await client.canReply(repo,"openreview"),false);
 await client.reply(repo,1,"Integer cents are required",43,"conversation:44");assert.deepEqual(post,{text:"Integer cents are required\n\n<!-- openreview:conversation:44 -->",parent:{id:43}});
});
