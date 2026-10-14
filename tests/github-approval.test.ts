import test from "node:test";
import assert from "node:assert/strict";
import {Github,GithubApiError} from "../src/github";
import {Gitea} from "../src/gitea";
import {z} from "zod";
const head="a".repeat(40);
test("GitHub approval reads native requirements, publisher identities, latest statuses and human objections",async t=>{
 const github=new Github("fixture",undefined,async()=>"openreview");let deny=false,planRestricted=false,protectedBranch=true;
 t.mock.method(github,"pullRequest",async()=>({number:1,title:"Docs",body:null,draft:false,state:"open",html_url:"https://github.com/o/r/pull/1",user:{login:"alice"},head:{sha:head,ref:"docs"},base:{sha:"b".repeat(40),ref:"main"},diff:[],comments:[],reviews:[],commits:[],checks:[]}));
 t.mock.method(github,"request",async(path:string,schema:z.ZodType)=>{
  let result:unknown;
  if(path.endsWith("/branches/main"))result={protected:protectedBranch};
  else if(path.endsWith("/protection")){if(deny)throw new Error("GitHub HTTP 403");result={required_status_checks:{contexts:["lint","legacy"],checks:[{context:"lint",app_id:42}]}};}
  else if(path.includes("/rules/branches/")){if(planRestricted)throw new GithubApiError("Feature unavailable",403,true);result=[{type:"required_status_checks",parameters:{required_status_checks:[{context:"security",integration_id:99}]}}];}
  else if(path.includes("/reviews?"))result=[{id:1,body:"Needs changes",commit_id:head,state:"CHANGES_REQUESTED",user:{login:"bob",type:"User"}},{id:2,body:"A comment",commit_id:head,state:"COMMENTED",user:{login:"bob",type:"User"}}];
  else if(path==="/installation")result={app_slug:"openreview"};
  else if(path.includes("/check-runs?"))result={check_runs:[{id:1,name:"lint",status:"completed",conclusion:"success",app:{id:42}}]};
  else if(path.includes("/statuses?"))result=[{context:"legacy",state:"failure"},{context:"legacy",state:"success"}];
  else throw new Error("Unexpected path "+path);
  return schema.parse(result);
 });
 const snapshot=await github.approvalSnapshot("o/r",1);
 assert.equal(snapshot.botLogin,"openreview[bot]");assert.equal(snapshot.humanChangeRequested,true);
 assert.deepEqual(snapshot.nativeRequiredChecks,[{name:"lint",appId:42},{name:"legacy"},{name:"security",appId:99}]);
 assert.equal(snapshot.checks.find(c=>c.name==="legacy")?.conclusion,"failure");
 deny=true;await assert.rejects(github.approvalSnapshot("o/r",1),/403/);
 deny=false;planRestricted=true;await assert.rejects(github.approvalSnapshot("o/r",1),/Feature unavailable/);
 protectedBranch=false;assert.deepEqual((await github.approvalSnapshot("o/r",1)).nativeRequiredChecks,[]);
 assert.equal(new Gitea("https://gitea.example","fixture").supportsApproval,true);
});
test("approval publication binds exact head, reuses only the installing bot review, and supports dismissal",async t=>{
 const github=new Github("fixture"),marker="<!-- openreview:approval:test -->";let created=0,own=false,stale=false,dismissed=false;
 t.mock.method(github,"request",async(path:string,schema:z.ZodType,options:RequestInit={})=>{
  let result:unknown;
  if(path.includes("/reviews?"))result=[{id:10,body:marker,commit_id:head,state:"APPROVED",user:{login:own?"openreview[bot]":"alice"}}];
  else if(path.endsWith("/pulls/1"))result={state:"open",draft:false,head:{sha:stale?"b".repeat(40):head}};
  else if(options.method==="POST"){const body=JSON.parse(String(options.body));assert.equal(body.commit_id,head);assert.equal(body.event,"APPROVE");assert.ok(body.body.includes(marker));created++;result={id:11,commit_id:head,state:"APPROVED"};}
  else if(options.method==="PUT"){assert.ok(path.endsWith("/reviews/11/dismissals"));dismissed=true;result={state:"DISMISSED"};}
  else if(path.endsWith("/reviews/11"))result={state:dismissed?"DISMISSED":"APPROVED"};
  else throw new Error("Unexpected path "+path);
  return schema.parse(result);
 });
 assert.deepEqual(await github.approve("o/r",1,head,marker,"openreview[bot]"),{id:11,reused:false});
 own=true;assert.equal((await github.approve("o/r",1,head,marker,"openreview[bot]")).reused,true);assert.equal(created,1);
 own=false;stale=true;await assert.rejects(github.approve("o/r",1,head,marker,"openreview[bot]"),/revision changed/);assert.equal(created,1);
 await github.dismissApproval("o/r",1,11);await github.dismissApproval("o/r",1,11);assert.equal(dismissed,true);
});
