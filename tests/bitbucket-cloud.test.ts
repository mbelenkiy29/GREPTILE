import test from "node:test";
import assert from "node:assert/strict";
import {BitbucketCloud,bitbucketCredential} from "../src/bitbucket-cloud";
import {parseDiff} from "../src/engine/diff";
import type {Finding} from "../src/engine/types";
test("Forge credentials remain opaque, bounded and expire before native requests",()=>{
 const receivedAt=Date.now(),c={systemToken:"fixture-system-token",publisherId:"11111111-1111-4111-8111-111111111111",receivedAt,expiresAt:receivedAt+90*60000};
 assert.equal(bitbucketCredential(JSON.stringify(c)).systemToken,c.systemToken);
 for(const change of [{systemToken:"bad token with spaces"},{publisherId:"foreign"},{expiresAt:receivedAt-1},{receivedAt:receivedAt+60000},{expiresAt:receivedAt+3*60*60000}])assert.throws(()=>bitbucketCredential(JSON.stringify({...c,...change})));
});

test("Bitbucket Cloud reads pinned native source/PRs and rejects tenant leaks, incomplete diffs and stale revisions",async t=>{
 const workspace="11111111-1111-4111-8111-111111111111",repositoryId="22222222-2222-4222-8222-222222222222",author="33333333-3333-4333-8333-333333333333";
 const sha="a".repeat(40),target="b".repeat(40),base="c".repeat(40),repo="acme/repo";
 const nativeRepo={uuid:"{"+repositoryId+"}",full_name:repo,workspace:{uuid:"{"+workspace+"}"}};
 const pr={id:1,title:"Billing change",description:null,draft:false,state:"OPEN",author:{uuid:author,type:"user"},source:{branch:{name:"fix"},commit:{hash:sha},repository:nativeRepo},destination:{branch:{name:"main"},commit:{hash:target},repository:nativeRepo}};
 const source=(path:string,type="commit_file",size=1)=>({type,path,commit:{hash:sha},size,attributes:[]});
 let mode="ok",prReads=0,calls=0;
 const prefix="/2.0/repositories/{"+workspace+"}/{"+repositoryId+"}";
 const patch="diff --git a/src/billing.ts b/src/billing.ts\n--- a/src/billing.ts\n+++ b/src/billing.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
 t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{
  calls++;const url=new URL(String(input)),path=decodeURIComponent(url.pathname);assert.equal(url.origin,"https://api.bitbucket.org");assert.equal(options?.redirect,"error");assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-system-token");
  assert.ok(path===prefix||path.startsWith(prefix+"/"));
  if(path===prefix)return Response.json(mode==="tenant"?{...nativeRepo,workspace:{uuid:author}}:nativeRepo);
  const endpoint=path.slice(prefix.length);
  if(endpoint==="/refs/branches/main")return Response.json({name:"main",target:{hash:sha}});
  if(endpoint==="/refs/branches")return Response.json({values:[{name:"main",target:{hash:sha}}]});
  if(endpoint==="/src/"+sha+"/"){
   if(mode==="page-escape")return Response.json({values:[source("src","commit_directory")],next:"https://evil.example/leak"});
   if(mode==="replay")return Response.json({values:[source("src","commit_directory")],next:url.href});
   if(mode==="revision")return Response.json({values:[{...source("README.md"),commit:{hash:target}}]});
   if(mode==="path")return Response.json({values:[source("src/hidden.ts")]});
   return Response.json({values:[source("README.md"),source("src","commit_directory")]});
  }
  if(endpoint==="/src/"+sha+"/src/")return Response.json({values:[source("src/billing.ts")]});
  if(endpoint==="/src/"+sha+"/src/billing.ts"){
   if(url.searchParams.get("format")==="meta")return Response.json({...source("src/billing.ts","commit_file",mode==="large"?200001:3),attributes:mode==="binary"?["binary"]:[]});
   return new Response(mode==="size"?"short":"new");
  }
  if(endpoint==="/pullrequests/1"){prReads++;return Response.json(mode==="stale"&&prReads>1?{...pr,destination:{...pr.destination,commit:{hash:base}}}:mode==="source-branch-changed"&&prReads>1?{...pr,source:{...pr.source,branch:{name:"other"}}}:mode==="destination-branch-changed"&&prReads>1?{...pr,destination:{...pr.destination,branch:{name:"other"}}}:mode==="author-changed"&&prReads>1?{...pr,author:{...pr.author,uuid:repositoryId}}:mode==="app-author"?{...pr,author:{...pr.author,type:"app_user"}}:mode==="unknown-author"?{...pr,author:{uuid:author}}:pr);}
  if(endpoint.startsWith("/merge-base/"))return Response.json({hash:base});
  if(endpoint.startsWith("/diffstat/")){assert.ok(endpoint.endsWith(sha+".."+target));assert.equal(url.searchParams.get("topic"),"true");return Response.json({values:[{status:"modified",lines_added:mode==="count"?2:1,lines_removed:1,old:{path:"src/billing.ts"},new:{path:"src/billing.ts"}}]});}
  if(endpoint.startsWith("/diff/")){assert.ok(endpoint.endsWith(sha+".."+target));return new Response(mode==="hunk"?patch.replace("+1,1","+1,2"):patch);}
  if(endpoint==="/pullrequests/1/comments")return Response.json({values:[{id:10,content:{raw:"Question"},user:{uuid:author},deleted:false,inline:{path:"src/billing.ts",to:1}},{id:11,content:{raw:"Deleted"},user:{uuid:author},deleted:true}]});
  if(endpoint==="/pullrequests/1/commits")return Response.json({values:[{hash:sha}]});
  if(endpoint==="/pullrequests/1/statuses")return Response.json({values:[{key:"ci",state:"SUCCESSFUL"}]});
  throw new Error("Unexpected native path "+endpoint);
 });
 const client=new BitbucketCloud("fixture-system-token",workspace,repositoryId);
 assert.equal(await client.head(repo,"main"),sha);assert.equal((await client.branches(repo)).branches[0].sha,sha);
 assert.deepEqual((await client.tree(repo,sha)).map(f=>[f.path,f.sha]),[["README.md",sha],["src/billing.ts",sha]]);
 assert.equal((await client.blob(repo,"src/billing.ts",sha)).content,"new");assert.ok(client.sourceUrl(repo,sha,"src/billing.ts").includes("/src/"+sha+"/src/billing.ts"));
 const change=await client.pullRequest(repo,1);assert.equal(change.authorExternalId,author);assert.equal(change.user.login,"{"+author+"}");assert.equal(change.base.sha,base);assert.equal(change.revisionKey,target);assert.equal(change.diff[0].path,"src/billing.ts");assert.equal(change.comments.length,1);assert.equal(change.checks[0].conclusion,"success");
 for(const bad of ["tenant","revision","path","page-escape","replay"]){mode=bad;const before=calls;await assert.rejects(client.tree(repo,sha));if(bad==="page-escape")assert.equal(calls,before+2);}
 for(const bad of ["count","hunk","stale","author-changed","source-branch-changed","destination-branch-changed"]){mode=bad;prReads=0;await assert.rejects(client.pullRequest(repo,1),/coverage|revision changed/);}
 for(const bad of ["app-author","unknown-author"]){mode=bad;prReads=0;assert.equal((await client.pullRequest(repo,1)).authorExternalId,undefined);}
 mode="large";assert.equal((await client.blob(repo,"src/billing.ts",sha)).size,200001);
 mode="binary";assert.equal((await client.blob(repo,"src/billing.ts",sha)).content,"\0");
 mode="size";await assert.rejects(client.blob(repo,"src/billing.ts",sha),/size mismatch/);
 assert.throws(()=>client.sourceUrl(repo,sha,"../secret"));assert.throws(()=>new BitbucketCloud("fixture-system-token","not-a-uuid",repositoryId));
 const removed=parseDiff("diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n")[0];assert.equal(removed.status,"removed");assert.equal(removed.previousPath,undefined);
});

test("Bitbucket Cloud publication/replies bind app identity, exact revision/anchor, native thread and effective permission",async t=>{
 const workspace="11111111-1111-4111-8111-111111111111",repositoryId="22222222-2222-4222-8222-222222222222",publisher="33333333-3333-4333-8333-333333333333",author="44444444-4444-4444-8444-444444444444";
 const sha="a".repeat(40),target="b".repeat(40),other="d".repeat(40),repo="acme/repo",marker="native-run",fingerprint="c".repeat(32);
 const tag="<!-- openreview:"+marker+" -->\n<!-- openreview-revision:"+sha+":"+target+" -->",findingTag="<!-- openreview-finding:"+fingerprint+" -->";
 const nativeRepo={uuid:repositoryId,full_name:repo,workspace:{uuid:workspace}};
 const pr={id:1,title:"Change",description:null,draft:false,state:"OPEN",author:{uuid:author,type:"user"},source:{branch:{name:"fix"},commit:{hash:sha},repository:nativeRepo},destination:{branch:{name:"main"},commit:{hash:target},repository:nativeRepo}};
 const finding:Finding={title:"Wrong amount returned",description:"The calculation converts integer cents into dollars.",severity:"high",confidence:1,category:"correctness",filePath:"price.ts",startLine:2,endLine:2,evidence:[{filePath:"price.ts",startLine:2,quote:"return amount / 100;"}],impact:"The consumer receives one hundredth of the expected amount.",suggestedFix:"Preserve integer cents.",symbol:"total",fingerprint,agent:"correctness",commitSha:sha};
 type Note={id:number;content:{raw:string};user:{uuid:string;type:string};deleted:boolean;pending?:boolean;inline?:{path:string;to:number};parent?:{id:number}};
 const notes:Note[]=[
  {id:1,content:{raw:findingTag+"\n"+tag},user:{uuid:author,type:"user"},deleted:false,inline:{path:"price.ts",to:2}},
  {id:2,content:{raw:findingTag+"\n"+tag},user:{uuid:publisher,type:"app_user"},deleted:false,inline:{path:"price.ts",to:3}},
  {id:3,content:{raw:findingTag+"\n"+tag.replace(sha,other)},user:{uuid:publisher,type:"app_user"},deleted:false,inline:{path:"price.ts",to:2}},
  {id:4,content:{raw:tag},user:{uuid:author,type:"user"},deleted:false},
 ];
 let posts=0,current=sha,responseAuthor=publisher,responseType="app_user",permission="read",status="active",permissionAuthor=author,permissionRepo=repositoryId,moveAfterPost=false;
 const prefix="/2.0/repositories/{"+workspace+"}/{"+repositoryId+"}";
 t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{
  const url=new URL(String(input)),path=decodeURIComponent(url.pathname);assert.equal(url.origin,"https://api.bitbucket.org");assert.equal(options?.redirect,"error");assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-system-token");
  if(path===prefix)return Response.json(nativeRepo);
  if(path===prefix+"/pullrequests/1")return Response.json({...pr,source:{...pr.source,commit:{hash:current}}});
  if(path===prefix+"/pullrequests/1/comments"){
   if(options?.method==="POST"){
    posts++;const body=JSON.parse(String(options.body));const row:Note={id:100+posts,content:body.content,user:{uuid:responseAuthor,type:responseType},deleted:false,...(body.inline?{inline:body.inline}:{}),...(body.parent?{parent:body.parent}:{})};notes.push(row);if(moveAfterPost)current=other;return Response.json(row);
   }
   return Response.json({values:notes});
  }
  if(path==="/2.0/workspaces/{"+workspace+"}/permissions/repositories/{"+repositoryId+"}"){
   assert.equal(url.searchParams.get("q"),'user.uuid="{'+author+'}"');return Response.json({values:[{permission,user:{uuid:permissionAuthor,type:"user",account_status:status},repository:{uuid:permissionRepo}}]});
  }
  throw new Error("Unexpected publication endpoint "+path);
 });
 const client=new BitbucketCloud("fixture-system-token",workspace,repositoryId,publisher);
 t.mock.method(client,"pullRequest",async()=>({number:1,title:"Change",body:null,draft:false,state:"open",html_url:"https://bitbucket.org/acme/repo/pull-requests/1",user:{login:author},head:{sha,ref:"fix"},base:{sha:target,ref:"main"},revisionKey:target,diff:[{path:"price.ts",status:"modified",patch:"@@ -1,2 +1,2 @@\n export function total(amount) {\n-return amount;\n+return amount / 100;\n"}],comments:[],reviews:[],commits:[],checks:[]}));
 assert.deepEqual(await client.publish(repo,1,sha,"Summary",[finding],marker,"detailed",target),{id:102,reused:false,comments:[{id:101,fingerprint}]});assert.equal(posts,2);
 assert.equal(notes.find(c=>c.id===101)?.inline?.to,2);assert.ok(notes.find(c=>c.id===101)?.content.raw.endsWith(tag));
 assert.deepEqual(await client.publish(repo,1,sha,"Summary",[finding],marker,"detailed",target),{id:102,reused:true,comments:[{id:101,fingerprint}]});assert.equal(posts,2);
 current=other;await assert.rejects(client.publish(repo,1,sha,"Summary",[finding],marker,"detailed",target),/revision changed/);current=sha;
 finding.startLine=1;await assert.rejects(client.publish(repo,1,sha,"Summary",[finding],marker,"detailed",target),/finding line/);finding.startLine=2;
 finding.commitSha=other;await assert.rejects(client.publish(repo,1,sha,"Summary",[finding],marker,"detailed",target),/finding line/);finding.commitSha=sha;assert.equal(posts,2);
 await assert.rejects(new BitbucketCloud("fixture-system-token",workspace,repositoryId).publish(repo,1,sha,"Summary",[],marker,"detailed",target),/publisher identity required/);assert.equal(posts,2);
 assert.equal(await client.canReply(repo,author),false);permission="write";assert.equal(await client.canReply(repo,author),true);
 status="inactive";assert.equal(await client.canReply(repo,author),false);status="active";
 assert.equal(await client.canReply(repo,publisher),false);assert.equal(await client.canReply(repo,"nickname"),false);
 permissionRepo=author;await assert.rejects(client.canReply(repo,author),/identity mismatch/);permissionRepo=repositoryId;
 permissionAuthor=publisher;await assert.rejects(client.canReply(repo,author),/identity mismatch/);permissionAuthor=author;
 const replyTag="<!-- openreview:conversation:10 -->";
 notes.push({id:10,content:{raw:"Question"},user:{uuid:author,type:"user"},deleted:false,parent:{id:101}},
  {id:11,content:{raw:replyTag},user:{uuid:author,type:"user"},deleted:false,parent:{id:101}},
  {id:12,content:{raw:replyTag},user:{uuid:publisher,type:"app_user"},deleted:false,parent:{id:2}});
 notes.find(n=>n.id===10)!.content.raw="@openreview why are units wrong?";
 assert.deepEqual(await client.followUp(repo,1,10,author),{commentId:10,author,question:"@openreview why are units wrong?",inline:true,parentCommentId:101});
 assert.equal(await client.followUp(repo,1,10,publisher),null);
 await assert.rejects(client.followUp(repo,1,999,author),/not available yet/);
 notes.find(n=>n.id===10)!.pending=true;assert.equal(await client.followUp(repo,1,10,author),null);notes.find(n=>n.id===10)!.pending=false;
 notes.find(n=>n.id===10)!.parent={id:999};await assert.rejects(client.followUp(repo,1,10,author),/parent unavailable/);
 notes.find(n=>n.id===10)!.parent={id:10};await assert.rejects(client.followUp(repo,1,10,author),/cycle/);notes.find(n=>n.id===10)!.parent={id:101};
 assert.deepEqual(await client.reply(repo,1,"Answer",101,"conversation:10"),{id:103});assert.equal(posts,3);
 assert.deepEqual(await client.reply(repo,1,"Answer",101,"conversation:10"),{id:103});assert.equal(posts,3);
 await assert.rejects(client.reply(repo,1,"Answer",999,"conversation:10"),/parent comment unavailable/);
 await assert.rejects(client.reply(repo,1,"Answer","101","conversation:10"));assert.equal(posts,3);
 responseAuthor=author;await assert.rejects(client.publish(repo,1,sha,"Other summary",[],"author-run","detailed",target),/summary identity mismatch/);
 responseAuthor=publisher;responseType="user";await assert.rejects(client.reply(repo,1,"Answer",101,"conversation:11"),/publisher or thread mismatch/);
 responseType="app_user";moveAfterPost=true;const before=posts;await assert.rejects(client.publish(repo,1,sha,"Moving head",[finding],"moving-run","detailed",target),/revision changed/);assert.equal(posts,before+1);assert.ok(notes.at(-1)?.inline);
});
