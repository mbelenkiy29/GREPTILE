import test from "node:test";
import assert from "node:assert/strict";
import {Github} from "../src/github";
import {Gitea} from "../src/gitea";
import type {Finding} from "../src/engine/types";

for(const kind of ["GitHub","Gitea"] as const)test(kind+" publication binds publisher, head, run marker and native changed-line findings",async t=>{
 const head="a".repeat(40),old="b".repeat(40),publisher=kind==="GitHub"?"openreview[bot]":"openreview",state=kind==="GitHub"?"COMMENTED":"COMMENT";
 const marker="current-run",tag="<!-- openreview:"+marker+" -->",fingerprint="c".repeat(64),findingTag="<!-- openreview-finding:"+fingerprint+" -->";
 const finding:Finding={title:"Wrong amount returned",description:"The cents calculation converts the return value into dollars.",severity:"high",confidence:1,category:"correctness",filePath:"price.ts",startLine:2,endLine:2,evidence:[{filePath:"price.ts",startLine:2,quote:"return amount / 100;"}],impact:"The consumer receives one hundredth of the expected amount.",suggestedFix:"Preserve integer cents.",symbol:"total",fingerprint,agent:"correctness",commitSha:head};
 const client=kind==="GitHub"?new Github("fixture",undefined,async()=>"openreview"):new Gitea("https://gitea.example","fixture");
 const reviews=[{id:1,body:tag,user:{login:"alice"},commit_id:head,state},{id:2,body:tag+"\n<!-- openreview:other-run -->",user:{login:publisher},commit_id:head,state},{id:3,body:tag,user:{login:publisher},commit_id:old,state},{id:4,body:tag,user:{login:publisher},commit_id:head,state:"PENDING"}];
 let currentHead=head,prReads=0,changeAt=Infinity,posts=0,missingRoot=false,createdAuthor=publisher,createdHead=head;
 const patch="@@ -1,2 +1,2 @@\n export function total(amount: number) {\n-return amount;\n+return amount / 100;";
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit={})=>{
  const u=new URL(input),path=u.pathname.replace(/^\/api\/v1/,"");assert.equal(options.redirect,"error");
  if(path==="/user")return Response.json({login:publisher});
  if(path==="/repos/o/r/pulls/1"){prReads++;if(prReads===changeAt)currentHead=old;return Response.json({state:"open",head:{sha:currentHead}});}
  if(path.endsWith("/files"))return Response.json([{filename:"price.ts",patch}]);
  if(path.endsWith("/pulls/1.diff"))return new Response("diff --git a/price.ts b/price.ts\n--- a/price.ts\n+++ b/price.ts\n"+patch);
  if(path.endsWith("/reviews")&&options.method==="POST"){
   posts++;const body=JSON.parse(String(options.body));assert.equal(body.commit_id,head);assert.equal(body.event,"COMMENT");assert.equal(body.comments[0].path,"price.ts");assert.equal(body.comments[0][kind==="GitHub"?"line":"new_position"],2);
   const result={id:100,body:body.body,user:{login:createdAuthor},commit_id:createdHead,state};reviews.push(result);return Response.json(result);
  }
  if(path.endsWith("/reviews"))return Response.json(reviews);
  if(path.endsWith("/reviews/100/comments")){
   const root={id:10,body:"Quoted source: <!-- openreview-finding:"+"d".repeat(64)+" -->\n\n"+findingTag,user:{login:publisher},commit_id:head,pull_request_review_id:100,path:"price.ts",...(kind==="GitHub"?{line:2,position:6}:{position:2})};
   return Response.json([...(missingRoot?[]:[root]),{...root,id:11,user:{login:"alice"}},{...root,id:12,in_reply_to_id:10,body:findingTag+"\n<!-- openreview:conversation:fixture -->"},{...root,id:13,line:3,position:3},{...root,id:14,commit_id:old},{...root,id:15,pull_request_review_id:99},{...root,id:16,body:"<!-- openreview-finding:"+"e".repeat(64)+" -->"},{...root,id:17,line:null,position:2}]);
  }
  throw new Error("Unexpected publication endpoint "+path);
 });
 assert.deepEqual(await client.publish("o/r",1,head,"Review summary",[finding],marker),{id:100,reused:false,comments:[{id:10,fingerprint}]});assert.equal(posts,1);
 assert.deepEqual(await client.publish("o/r",1,head,"Review summary",[finding],marker),{id:100,reused:true,comments:[{id:10,fingerprint}]});assert.equal(posts,1);
 currentHead=old;await assert.rejects(client.publish("o/r",1,head,"Stale",[finding],marker),/changed/);assert.equal(posts,1);
 currentHead=head;prReads=0;changeAt=2;await assert.rejects(client.publish("o/r",1,head,"Changed during retry",[finding],marker),/changed/);assert.equal(posts,1);
 currentHead=head;changeAt=Infinity;missingRoot=true;await assert.rejects(client.publish("o/r",1,head,"Missing native finding",[finding],marker),/publication incomplete/);missingRoot=false;
 finding.startLine=1;await assert.rejects(client.publish("o/r",1,head,"Wrong line",[finding],"next-run"),/line not in complete/);finding.startLine=2;finding.commitSha=old;await assert.rejects(client.publish("o/r",1,head,"Wrong finding revision",[finding],"next-run"),/line not in complete/);finding.commitSha=head;assert.equal(posts,1);
 createdAuthor="alice";await assert.rejects(client.publish("o/r",1,head,"Wrong author",[finding],"author-run"),/another publication identity/);createdAuthor=publisher;createdHead=old;await assert.rejects(client.publish("o/r",1,head,"Wrong revision",[finding],"revision-run"),/another publication identity/);
});

test("GitHub reply retries ignore human markers and markers from another thread",async t=>{
 const client=new Github("fixture",undefined,async()=>"openreview"),marker="conversation:fixture",tag="<!-- openreview:"+marker+" -->";
 let posted=0,comments=[{id:1,body:tag,user:{login:"alice"},in_reply_to_id:10},{id:2,body:tag,user:{login:"openreview[bot]"},in_reply_to_id:20},{id:3,body:tag+"\nSome other text",user:{login:"openreview[bot]"},in_reply_to_id:10}];
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit={})=>{
  const u=new URL(input);if(options.method==="POST"){assert.equal(u.pathname,"/repos/o/r/pulls/1/comments/10/replies");posted++;const c={id:4,body:JSON.parse(String(options.body)).body,user:{login:"openreview[bot]"},in_reply_to_id:10};comments=[...comments,c];return Response.json(c);}return Response.json(comments);
 });
 assert.deepEqual(await client.reply("o/r",1,"Answer",10,marker),{id:4});assert.equal(posted,1);assert.deepEqual(await client.reply("o/r",1,"Answer",10,marker),{id:4});assert.equal(posted,1);
 await assert.rejects(client.reply("o/r",1,"Answer","10",marker),/Invalid GitHub review comment identity/);await assert.rejects(client.reply("o/r",1,"Answer",0,marker),/Invalid GitHub review comment identity/);assert.equal(posted,1);
});
