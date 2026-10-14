import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { encryptCredential,decryptCredential,providerOrigin } from "../src/credentials";
import { Gitlab } from "../src/gitlab";
import type { Finding } from "../src/engine/types";
import { Gitea } from "../src/gitea";
test("GitLab runtime archives require immutable revisions and bound authenticated same-origin downloads",async t=>{
 const sha="a".repeat(40),gzip=new Uint8Array([0x1f,0x8b,8,0]);let calls=0,mode="ok",cancelled=false;
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
  calls++;const url=new URL(input);assert.equal(url.pathname,"/api/v4/projects/123/repository/archive.tar.gz");
  assert.equal(url.searchParams.get("sha"),sha);assert.equal(url.searchParams.get("include_lfs_blobs"),"false");
  // OpenReview follows only same-origin redirects itself (src/scm-transport.ts), so fetch never follows one.
  assert.equal(options.redirect,"manual");assert.equal(options.mode,"same-origin");assert.equal((options.headers as Record<string,string>)["PRIVATE-TOKEN"],"fixture-token");
  if(mode==="redirect")return new Response(null,{status:302,headers:{location:"https://archive.example/download.tar.gz"}});
  if(mode==="denied")return new Response(null,{status:403});
  if(mode==="missing")return new Response(null);
  if(mode==="header")return new Response(gzip,{headers:{"content-length":"20000001"}});
  if(mode==="stream")return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(20000001));},cancel(){cancelled=true;}}));
  return new Response(mode==="html"?new TextEncoder().encode("<html>login</html>"):gzip);
 });
 const client=new Gitlab("https://gitlab.com","fixture-token","123");
 for(const revision of ["main","a".repeat(39),sha+"&sha=main"])await assert.rejects(client.archive("renamed/repo",revision),/exact Git commit/);
 assert.equal(calls,0);assert.deepEqual(await client.archive("renamed/repo",sha),gzip);
 for(const [next,pattern] of [["redirect",/another host \(archive\.example\)/],["denied",/unavailable/],["missing",/missing/],["header",/too large/],["stream",/exceeds 20 MB/],["html",/not gzip/]] as const){mode=next;await assert.rejects(client.archive("renamed/repo",sha),pattern);}
 assert.equal(cancelled,true);
});
test("provider credentials are authenticated to scope and operator-authorized HTTPS instances",()=>{
 process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-credential-key-at-least-32-characters";
 const encrypted=encryptCredential("fixture-token","org:gitlab");
 assert.ok(!encrypted.includes("fixture-token"));assert.equal(decryptCredential(encrypted,"org:gitlab"),"fixture-token");
 assert.throws(()=>decryptCredential(encrypted,"other-org:gitlab"));assert.throws(()=>decryptCredential(encrypted+"x","org:gitlab"));
 assert.equal(providerOrigin("https://gitlab.com",["gitlab.com"]),"https://gitlab.com");
 for(const url of ["http://gitlab.com","https://evil.example","https://secret@gitlab.com","https://gitlab.com?token=x"])assert.throws(()=>providerOrigin(url,["gitlab.com"]));
});
test("GitLab revision/tree/discovery use native project identities and reject truncated diffs",async t=>{
 const called:string[]=[];
 let omitted=true,changed=false,reads=0;
 t.mock.method(globalThis,"fetch",async(url:string,options:RequestInit)=>{
  called.push(url);assert.equal((options.headers as Record<string,string>)["PRIVATE-TOKEN"],"fixture-token");assert.equal(options.redirect,"manual");
  if(url.includes("/projects?"))return Response.json([{id:123,path_with_namespace:"group/repo",default_branch:"main",http_url_to_repo:"https://gitlab.com/group/repo.git"}]);
  if(url.includes("/repository/tree"))return Response.json([{id:"b".repeat(40),path:"src/api.ts",type:"blob"}]);
  if(url.includes("/repository/commits/"))return Response.json({id:"a".repeat(40)});
  if(url.includes("/merge_requests/1/diffs"))return Response.json([{new_path:"a.ts",old_path:"a.ts",new_file:false,deleted_file:false,renamed_file:false,diff:"",too_large:omitted}]);
  if(url.includes("/merge_requests/1/"))return Response.json([]);
  return Response.json({iid:1,title:"Change",description:"",draft:false,state:"opened",web_url:"https://gitlab.com/group/repo/-/merge_requests/1",author:{username:"alice"},source_branch:"feature",target_branch:"main",diff_refs:{base_sha:changed&&++reads===2?"c".repeat(40):"a".repeat(40),head_sha:"b".repeat(40),start_sha:"a".repeat(40)}});
 });
 const client=new Gitlab("https://gitlab.com","fixture-token","123");
 assert.equal((await client.repositories())[0].externalId,"123");
 assert.equal(await client.head("renamed/group/repo","main"),"a".repeat(40));
 assert.equal((await client.tree("renamed/group/repo","a".repeat(40)))[0].path,"src/api.ts");
 await assert.rejects(client.pullRequest("renamed/group/repo",1),/omitted diffs/);
 omitted=false;assert.equal((await client.pullRequest("renamed/group/repo",1)).revisionKey,"a".repeat(40)+":"+"a".repeat(40));
 changed=true;await assert.rejects(client.pullRequest("renamed/group/repo",1),/revision changed during ingestion/);
 assert.ok(called.some(url=>url.includes("/projects/123/repository/tree")));
});
test("GitLab follow-ups require effective active write membership and retain native discussion identity",async t=>{
 let level=20,state="active",expires:string|null=null,memberStatus=200,username="alice",locked=false;
 const root={id:10,body:"Finding",author:{username:"openreview"}},question={id:11,body:"@openreview why?",author:{username:"alice"}};
 let notes=[{id:12,body:"<!-- openreview:conversation:11 -->",author:{username:"alice"}}];let posts=0;
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
  const url=new URL(input);assert.equal(options.redirect,"manual");
  if(url.pathname.endsWith("/user"))return Response.json({id:1,username:"openreview"});
  if(url.pathname.endsWith("/users")){assert.equal(url.searchParams.get("without_project_bots"),"true");return Response.json([{id:2,username,state,locked}]);}
  if(url.pathname.endsWith("/members/all/2"))return Response.json({id:2,username:"alice",state,access_level:level,expires_at:expires},{status:memberStatus});
  if(url.pathname.endsWith("/discussions/thread/notes")){posts++;assert.ok(JSON.parse(String(options.body)).body.includes("<!-- openreview:conversation:11 -->"));return Response.json({id:13});}
  if(url.pathname.endsWith("/discussions"))return Response.json([{id:"thread",notes:[root,question]}]);
  if(url.pathname.endsWith("/notes"))return Response.json(notes);
  throw new Error("Unexpected GitLab endpoint "+url.pathname);
 });
 const client=new Gitlab("https://gitlab.com","fixture-token","123");
 assert.equal(await client.canReply("renamed/repo","alice"),false);level=30;
 assert.equal(await client.canReply("renamed/repo","alice"),true);
 assert.equal(await client.canReply("renamed/repo","openreview"),false);
 state="blocked";assert.equal(await client.canReply("renamed/repo","alice"),false);state="active";
 locked=true;assert.equal(await client.canReply("renamed/repo","alice"),false);locked=false;
 username="alice-other";assert.equal(await client.canReply("renamed/repo","alice"),false);username="alice";
 expires="2000-01-01";assert.equal(await client.canReply("renamed/repo","alice"),false);expires=null;
 memberStatus=404;assert.equal(await client.canReply("renamed/repo","alice"),false);
 memberStatus=403;await assert.rejects(client.canReply("renamed/repo","alice"),/GitLab 403/);memberStatus=200;
 assert.equal(await client.discussionParent("renamed/repo",1,11,"alice","@openreview why?"),10);
 await assert.rejects(client.discussionParent("renamed/repo",1,11,"alice","edited"),/changed/);
 assert.equal((await client.reply("renamed/repo",1,"Answer",10,"conversation:11")).id,13);assert.equal(posts,1);
 notes=[{id:13,body:"<!-- openreview:conversation:11 -->",author:{username:"openreview"}}];
 assert.equal((await client.reply("renamed/repo",1,"Answer",10,"conversation:11")).id,13);assert.equal(posts,1);
});
test("GitLab publication binds bot, run, revision and added line, and resumes a partial publication",async t=>{
 const head="b".repeat(40),base="a".repeat(40),marker="review-one",fingerprint="f".repeat(32);
 const finding:Finding={title:"Wrong cents",description:"Wrong payment units",severity:"high",confidence:1,category:"correctness",filePath:"price.ts",startLine:2,endLine:2,evidence:[{filePath:"price.ts",startLine:2,quote:"return price / 100;"}],impact:"Undercharges",suggestedFix:"Return cents",symbol:"amount",fingerprint,agent:"correctness",commitSha:head};
 const position={head_sha:head,new_path:"price.ts",new_line:2};
 const findingMarker="<!-- openreview:"+marker+":finding:"+fingerprint+" -->",summaryMarker="<!-- openreview:"+marker+" -->\n<!-- openreview-revision:"+head+" -->";
 type Note={id:number;body:string;author:{username:string};position?:typeof position};
 const notes:Note[]=[{id:1,body:findingMarker,author:{username:"alice"},position},{id:2,body:findingMarker,author:{username:"openreview"},position:{...position,head_sha:base}},{id:3,body:"<!-- openreview-finding:"+fingerprint+" -->",author:{username:"openreview"},position},{id:4,body:summaryMarker,author:{username:"alice"}}];
 const patch="@@ -1,2 +1,2 @@\n function amount(price) {\n- return price;\n+ return price / 100;";
 let discussions=0,summaries=0,edits=0,failSummary=true,currentHead=head,currentBase=base,reads=0,changeAt=Infinity,omit=false;
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
  const url=new URL(input);assert.equal(options.redirect,"manual");
  if(url.pathname.endsWith("/user"))return Response.json({username:"openreview"});
  if(url.pathname.endsWith("/merge_requests/1")){
   if(++reads===changeAt)currentHead=base;
   return Response.json({iid:1,title:"Change",description:"",draft:false,state:"opened",web_url:"https://gitlab.com/group/repo/-/merge_requests/1",author:{username:"alice"},source_branch:"feature",target_branch:"main",diff_refs:{base_sha:currentBase,head_sha:currentHead,start_sha:base}});
  }
  if(url.pathname.endsWith("/diffs"))return Response.json([{new_path:"price.ts",old_path:"old-price.ts",diff:patch,too_large:omit}]);
  if(url.pathname.endsWith("/discussions")){
   discussions++;const body=JSON.parse(String(options.body));assert.equal(body.position.old_path,"old-price.ts");assert.equal(body.position.head_sha,head);assert.equal(body.position.new_line,2);assert.equal(body.position.old_line,undefined);
   const posted={id:20+discussions,body:body.body,author:{username:"openreview"},position:body.position};notes.push(posted);return Response.json({notes:[posted]});
  }
  if(/\/notes\/\d+$/.test(url.pathname)&&options.method==="PUT"){edits++;const n=notes.find(n=>url.pathname.endsWith("/notes/"+n.id))!;n.body=JSON.parse(String(options.body)).body;return Response.json(n);}
  if(url.pathname.endsWith("/notes")){
   if(options.method==="POST"){if(failSummary)return Response.json({},{status:503});summaries++;const posted={id:50+summaries,body:JSON.parse(String(options.body)).body,author:{username:"openreview"}};notes.push(posted);return Response.json(posted);}
   return Response.json(notes);
  }
  throw new Error("Unexpected GitLab endpoint "+url.pathname);
 });
 const client=new Gitlab("https://gitlab.com","fixture-token","123"),publish=()=>client.publish("group/repo",1,head,"Summary",[finding],marker);
 await assert.rejects(publish(),/GitLab 503/);assert.equal(discussions,1);
 failSummary=false;const resumed=await publish();assert.equal(resumed.reused,false);assert.equal(discussions,1);assert.equal(summaries,1);assert.equal(resumed.comments[0].id,21);
 assert.ok(notes.at(-1)!.body.includes("/-/commit/"+head));
 assert.equal((await publish()).reused,true);assert.equal(discussions,1);assert.equal(summaries,1);
 // A new run edits the single summary note in place instead of adding another.
 await client.publish("group/repo",1,head,"New run",[finding],"review-two");assert.equal(discussions,2);assert.equal(summaries,1);assert.equal(edits,1);
 assert.ok(notes.find(n=>n.id===51)!.body.includes("New run"));
 const posts=discussions+summaries+edits;finding.startLine=1;await assert.rejects(publish(),/line not in complete/);finding.startLine=2;
 omit=true;await assert.rejects(publish(),/line not in complete/);omit=false;
 currentHead=base;await assert.rejects(publish(),/revision changed/);currentHead=head;
 reads=0;changeAt=2;await assert.rejects(client.publish("group/repo",1,head,"Stale",[finding],"review-three"),/revision changed/);assert.equal(discussions+summaries+edits,posts);
 currentHead=head;changeAt=Infinity;currentBase="c".repeat(40);reads=0;
 await assert.rejects(client.publish("group/repo",1,head,"Already stale",[finding],"stale-run","detailed",base+":"+base),/revision changed/);reads=0;
 // A native base change during publication must invalidate the snapshot as well.
 const originalFetch=globalThis.fetch;t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{if(String(input).endsWith("/merge_requests/1")&&reads===1)currentBase=base;return originalFetch(input,options);});
 await assert.rejects(client.publish("group/repo",1,head,"Stale base",[finding],"review-four"),/revision changed/);assert.equal(discussions+summaries+edits,posts);
});
test("Gitea permissions validate the native user and replies stay in the scoped review thread",async t=>{
 let permission="read",active=true,prohibit=false,type="User",login="alice",parentPresent=true,posts=0,reviews=1;
 let comments=[{id:10,body:"Finding",user:{login:"openreview"},pull_request_review_id:1,path:"price.ts",position:2},{id:11,body:"<!-- openreview:conversation:12 -->",user:{login:"alice"},pull_request_review_id:1,path:"price.ts",position:2},{id:12,body:"<!-- openreview:conversation:12 -->",user:{login:"openreview"},pull_request_review_id:1,path:"price.ts",position:3}];
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
  const url=new URL(input);assert.equal(new Headers(options.headers).get("authorization"),"token fixture");assert.equal(options.redirect,"error");
  if(url.pathname.endsWith("/user"))return Response.json({id:1,login:"openreview"});
  if(url.pathname.endsWith("/permission"))return Response.json({permission,user:{id:2,login,active,prohibit_login:prohibit,type}});
  if(url.pathname.endsWith("/reviews")){const start=(Number(url.searchParams.get("page"))-1)*100;return Response.json(Array.from({length:reviews},(_,i)=>({id:i+1})).slice(start,start+100));}
  if(url.pathname.endsWith("/reviews/1/comments"))return Response.json(parentPresent?comments:[]);
  if(options.method==="POST"){
   assert.equal(url.pathname,"/api/v1/repos/acme/repo/pulls/1/comments/10/replies");assert.ok(!JSON.parse(String(options.body)).body.startsWith("In reply"));posts++;return Response.json({id:20,user:{login:"openreview"}});
  }
  throw new Error("Unexpected native Gitea endpoint "+url.pathname);
 });
 const client=new Gitea("https://gitea.example","fixture");
 assert.equal(await client.canReply("acme/repo","alice"),false);permission="owner";assert.equal(await client.canReply("acme/repo","alice"),true);
 assert.equal(await client.canReply("acme/repo","openreview"),false);
 active=false;assert.equal(await client.canReply("acme/repo","alice"),false);active=true;
 prohibit=true;assert.equal(await client.canReply("acme/repo","alice"),false);prohibit=false;
 type="Bot";assert.equal(await client.canReply("acme/repo","alice"),false);type="User";
 login="other";assert.equal(await client.canReply("acme/repo","alice"),false);login="alice";
 assert.equal((await client.reply("acme/repo",1,"Answer",10,"conversation:12")).id,20);assert.equal(posts,1);
 comments=[{id:10,body:"Finding",user:{login:"openreview"},pull_request_review_id:1,path:"price.ts",position:2},{id:20,body:"<!-- openreview:conversation:12 -->",user:{login:"openreview"},pull_request_review_id:1,path:"price.ts",position:2}];
 assert.equal((await client.reply("acme/repo",1,"Answer",10,"conversation:12")).id,20);assert.equal(posts,1);
 parentPresent=false;await assert.rejects(client.reply("acme/repo",1,"Answer",10),/parent comment unavailable/);
 await assert.rejects(client.reply("acme/repo",1,"Answer","10"),/Invalid/);
 reviews=101;await assert.rejects(client.reply("acme/repo",1,"Answer",10),/lookup limit/);assert.equal(posts,1);
});
test("Gitea native timeline distinguishes inline replies and submitted reviews, retaining publisher-owned finding parents",async t=>{
 const body="@openreview why?",marker="<!-- openreview-finding:"+"a".repeat(32)+" -->";
 const timeline=[{id:11,type:"code",body,review_id:1,user:{login:"alice"}},{id:30,type:"review",body:"",review_id:1,user:{login:"alice"}},{id:31,type:"review",body:"",review_id:1,user:{login:"alice"}},{id:32,type:"review",body:"",review_id:2,user:{login:"bob"}},{id:40,type:"comment",body,review_id:0,user:{login:"alice"}}];
 let state="COMMENT",author="alice",inlineBody=body,omitCode=false;
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
  const url=new URL(input);assert.equal(options.redirect,"error");assert.equal(new Headers(options.headers).get("authorization"),"token fixture");
  if(url.pathname.endsWith("/timeline"))return Response.json(omitCode?timeline.filter(c=>c.type!=="code"):timeline);
  if(url.pathname.endsWith("/reviews"))return Response.json([{id:1}]);
  if(url.pathname.endsWith("/user"))return Response.json({login:"openreview"});
  if(url.pathname.endsWith("/reviews/1/comments"))return Response.json([{id:8,body:marker+"\n<!-- openreview:conversation:quoted -->",user:{login:"openreview"},pull_request_review_id:1,path:"price.ts",position:2},{id:9,body:marker,user:{login:"alice"},pull_request_review_id:1,path:"price.ts",position:2},{id:10,body:marker,user:{login:"openreview"},pull_request_review_id:1,path:"price.ts",position:2},{id:11,body:inlineBody,user:{login:"alice"},pull_request_review_id:1,path:"price.ts",position:2},{id:12,body:"@openreview review security",user:{login:"alice"},pull_request_review_id:1,path:"price.ts",position:3},{id:13,body:"@openreview private question",user:{login:"bob"},pull_request_review_id:1,path:"price.ts",position:2}]);
  if(url.pathname.endsWith("/reviews/1"))return Response.json({id:1,body:"",state,user:{login:author}});
  throw new Error("Unexpected Gitea native path "+url.pathname);
 });
 const client=new Gitea("https://gitea.example","fixture");
 assert.deepEqual(await client.followUps("acme/repo",1,"alice",{commentId:11,body}),[{commentId:11,body,inline:true,parentCommentId:10}]);
 omitCode=true;assert.deepEqual(await client.followUps("acme/repo",1,"alice",{commentId:11,body}),[{commentId:11,body,inline:true,parentCommentId:10}]);omitCode=false;
 assert.deepEqual(await client.followUps("acme/repo",1,"alice",{commentId:40,body}),[{commentId:40,body,inline:false}]);
 assert.deepEqual(await client.followUps("acme/repo",1,"alice",{reviewContent:"",state:"COMMENT"}),[{commentId:11,body,inline:true,parentCommentId:10},{commentId:12,body:"@openreview review security",inline:true,parentCommentId:12}]);
 assert.deepEqual(await client.followUps("acme/repo",1,"alice",{reviewContent:"",state:"APPROVED"}),[]);
 await assert.rejects(client.followUps("acme/repo",1,"alice",{commentId:11,body:"edited"}),/changed/);
 inlineBody="edited";await assert.rejects(client.followUps("acme/repo",1,"alice",{commentId:11,body}),/changed/);inlineBody=body;
 state="PENDING";await assert.rejects(client.followUps("acme/repo",1,"alice",{reviewContent:"",state:"COMMENT"}),/submitted review changed/);state="COMMENT";
 author="bob";await assert.rejects(client.followUps("acme/repo",1,"alice",{reviewContent:"",state:"COMMENT"}),/submitted review changed/);
});

test("Origin's native Ed25519 webhook signature binds delivery, timestamp and exact body",async()=>{
 const {generateKeyPairSync,sign,createHash}=await import("node:crypto");
 const {verifyOriginSignature}=await import("../src/origin-auth");
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 const keys=[publicKey.export({format:"jwk"})];
 const timestamp=String(Math.floor(Date.now()/1000)),body='{"event":{"type":"pull_request.created"}}',id="event_123";
 const digest=Buffer.from(createHash("sha256").update(id+"."+timestamp+"."+body).digest("hex"));
 const signature="v1ed,"+sign(null,digest,privateKey).toString("base64");
 assert.equal(verifyOriginSignature(body,id,timestamp,signature,keys),true);
 assert.equal(verifyOriginSignature(body+" ",id,timestamp,signature,keys),false);
 assert.equal(verifyOriginSignature(body,"other",timestamp,signature,keys),false);
 assert.equal(verifyOriginSignature(body,id,timestamp,signature,keys,Date.now()+301000),false);
 assert.equal(verifyOriginSignature(body,id,timestamp,"v1,"+signature.slice(5),keys),false);
});

test("Origin installation auth and source APIs retain opaque IDs and reject truncated trees",async()=>{
 const {generateKeyPairSync}=await import("node:crypto");const {decodeJwt,decodeProtectedHeader}=await import("jose");
 const {Origin}=await import("../src/origin");const {privateKey}=generateKeyPairSync("ed25519");const original=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{
  const url=String(input);
  if(url.endsWith("/access_tokens")){
   const jwt=String(new Headers(options?.headers).get("authorization")).slice(7);
   assert.equal(decodeProtectedHeader(jwt).alg,"EdDSA");assert.equal(decodeProtectedHeader(jwt).kid,"app_test");assert.equal(decodeJwt(jwt).aud,"origin-apps");
   return Response.json({token:"oit_fixture",expiresAt:new Date(Date.now()+240000).toISOString()});
  }
  assert.equal(new Headers(options?.headers).get("authorization"),"Bearer oit_fixture");
  if(url.includes("/installation/repos"))return Response.json({repositories:[{id:"repo_opaque",fullName:"acme/renamed",defaultBranch:"main"}]});
  if(url.includes("/git/trees/"))return Response.json({truncated:true,tree:[]});
  throw new Error("Unexpected Origin contract endpoint");
 };
 try{
  const client=new Origin({appId:"app_test",installationId:"inst_test",privateKey:privateKey.export({type:"pkcs8",format:"pem"}).toString()},"repo_opaque");
  assert.equal((await client.repositories())[0].externalId,"repo_opaque");
  assert.equal(client.sourceUrl("acme/renamed","a".repeat(40),"src/api.ts"),`https://cursor.com/codebase/acme/renamed/blob/${"a".repeat(40)}/src/api.ts`);
  await assert.rejects(client.tree("acme/renamed","a".repeat(40)),/truncated/);
 }finally{globalThis.fetch=original;}
});

test("Origin receipts require the configured app, cookie state and live Ed25519 signature",async t=>{
 const {generateKeyPairSync}=await import("node:crypto"),{SignJWT}=await import("jose"),{verifyOriginReceipt,originApi}=await import("../src/origin-auth");
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 t.mock.method(globalThis,"fetch",async(url:string)=>{assert.equal(url,originApi+"/keys");return Response.json({keys:[{...publicKey.export({format:"jwk"}),kid:"fixture-key",alg:"EdDSA"}]});});
 const receipt=await new SignJWT({state:"cookie-state",namespace_id:"ns_fixture",jti:"receipt-fixture"}).setProtectedHeader({alg:"EdDSA",kid:"fixture-key",typ:"origin-installation-receipt+jwt"}).setIssuer(originApi).setAudience("app_fixture").setSubject("inst_fixture").setIssuedAt().setExpirationTime("5m").sign(privateKey);
 assert.equal((await verifyOriginReceipt(receipt,"app_fixture","cookie-state")).sub,"inst_fixture");
 await assert.rejects(verifyOriginReceipt(receipt,"app_other","cookie-state"));
 await assert.rejects(verifyOriginReceipt(receipt,"app_fixture","wrong-state"),/state/);
 await assert.rejects(verifyOriginReceipt(receipt.slice(0,-5)+"AAAAA","app_fixture","cookie-state"));
});
test("Origin follow-ups require the exact active user to hold repository write permission",async t=>{
 const {Origin}=await import("../src/origin"),{generateKeyPairSync}=await import("node:crypto");
 const {privateKey}=generateKeyPairSync("ed25519");
 let permission="read",id="user_fixture";
 t.mock.method(Origin.prototype,"request",async(_endpoint:string,validator:z.ZodType)=>validator.parse({user:{id},permission}));
 const client=new Origin({appId:"app_fixture",installationId:"inst_fixture",privateKey:privateKey.export({format:"pem",type:"pkcs8"}).toString()},"repo_fixture");
 assert.equal(await client.canReply("acme/repo","app_fixture"),false);
 assert.equal(await client.canReply("acme/repo","user_fixture"),false);
 permission="write";assert.equal(await client.canReply("acme/repo","user_fixture"),true);
 id="user_other";assert.equal(await client.canReply("acme/repo","user_fixture"),false);
});
