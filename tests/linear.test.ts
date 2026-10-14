import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Linear,LinearError,linearAuthorization,linearToken,revokeLinear } from "../src/linear";
import {reviewChange,reviewSummarySchema,grounded} from "../src/engine/review";
import type {ModelProvider,ReviewInput,Candidate} from "../src/engine/types";

test("review evidence retains fetched Linear requirements and rejects invented issue citations",async()=>{
 const sourceUrl="https://linear.app/engineering/issue/ENG-42/return-cents",path="requirements/linear/connection/ENG-42.md",quote="Amounts must be integer cents.";
 const input:ReviewInput={repository:"alice/billing",baseSha:"base",headSha:"head",title:"ENG-42 cents",description:"",mode:"fast",rules:[],settings:{categories:["correctness"]},files:[{path:"billing.ts",sha:"head",content:"export const total = (amount: number) => amount / 100;"},{path,sha:"2026-10-02T12:00:00.000Z",content:quote,provenance:{repository:"Linear: Engineering",revision:"2026-10-02T12:00:00.000Z",sourceUrl}}],diff:[{path:"billing.ts",status:"modified",patch:"@@ -1 +1 @@\n-export const total = (amount: number) => amount;\n+export const total = (amount: number) => amount / 100;"}],contextHints:[{path,reason:"fetched requirements",score:100}],coverageLimits:["Requirements retrieval limited to referenced issues."]};
 const candidate:Candidate={title:"Amounts are returned in dollars",description:"The implementation contradicts the integer cents requirement in "+sourceUrl,severity:"high",confidence:1,category:"correctness",filePath:"billing.ts",startLine:1,endLine:1,evidence:[{filePath:path,startLine:1,quote}],impact:"Consumers receive a value 100 times too small.",suggestedFix:"Keep the amount in integer cents.",symbol:"total"};
 const omittedUrl="https://linear.app/engineering/issue/ENG-99/unrelated";
 input.files.push({path:"requirements/linear/connection/ENG-99.md",sha:"old",content:"Lions roam.",provenance:{repository:"Linear: Engineering",revision:"old",sourceUrl:omittedUrl}});
 const model:ModelProvider={generate:async(request,schema)=>{
  assert.ok(JSON.stringify([request.context,request.input]).includes(sourceUrl));
  assert.equal(JSON.stringify([request.context,request.input]).includes(omittedUrl),false);
  const value=request.task.startsWith("review:")?{findings:[candidate]}:request.task==="verify"?{decisions:[{index:0,publish:true,confidence:1,reason:"The fetched requirement explicitly specifies integer cents."}]}:{reviewScore:{value:1,reason:"The verified defect needs correction before this change is ready to merge."},summary:"The cents requirement conflicts with the changed implementation."};
  return {value:schema.parse(value),usage:{task:request.task,provider:"fixture",model:"fixture",inputTokens:0,outputTokens:0,latencyMs:0,estimatedCost:0,cached:false}};
 }};
 const result=await reviewChange(input,model);assert.equal(result.findings.length,1);assert.equal(result.findings[0].evidence[0].sourceUrl,sourceUrl);assert.equal(result.findings[0].evidence[0].revision,"2026-10-02T12:00:00.000Z");assert.ok(result.metadata.coverageLimits!.includes(input.coverageLimits![0]));
 assert.ok(result.summary.includes("Fetched requirements supplied as review context:"));assert.ok(result.summary.includes(sourceUrl));assert.equal(result.summary.includes(omittedUrl),false);assert.deepEqual(result.metadata.context.find(c=>c.path===path)?.provenance,input.files[1].provenance);
 const invented=sourceUrl.replace("ENG-42","ENG-43");assert.equal(grounded({...candidate,description:"According to "+invented},input),false);
 assert.equal(reviewSummarySchema(undefined,[sourceUrl]).safeParse({reviewScore:{value:1,reason:"The verified defect needs correction before this change is ready to merge."},summary:"The fetched requirements are described in [ENG-42]("+sourceUrl+")."}).success,true);
 assert.equal(reviewSummarySchema(undefined,[sourceUrl]).safeParse({reviewScore:{value:1,reason:"The verified defect needs correction before this change is ready to merge."},summary:"The requirements are described in "+invented}).success,false);
});

test("Linear OAuth uses read-only S256 PKCE, rotating refresh tokens and native revocation",async t=>{
 const verifier="v".repeat(43),state="s".repeat(32),url=new URL(linearAuthorization("client","http://localhost:3000/api/integrations/linear/callback",state,verifier));
 assert.equal(url.origin,"https://linear.app");assert.equal(url.pathname,"/oauth/authorize");assert.equal(url.searchParams.get("scope"),"read");assert.equal(url.searchParams.get("state"),state);assert.equal(url.searchParams.get("code_challenge_method"),"S256");assert.equal(url.searchParams.get("code_challenge"),createHash("sha256").update(verifier).digest("base64url"));
 for(const redirect of ["http://remote.example/callback","https://user:secret@example.com/callback","https://example.com/callback?redirect=evil","https://example.com/callback#fragment"])assert.throws(()=>linearAuthorization("client",redirect,state,verifier));
 assert.throws(()=>linearAuthorization("client","https://example.com/callback","short",verifier));
 let scope:string|string[]="read",status=200,expires=86399,token=0;const requests:{url:string;body:URLSearchParams}[]=[];
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
  const u=new URL(input);assert.equal(u.origin,"https://api.linear.app");assert.equal(options.method,"POST");assert.equal(options.redirect,"error");assert.equal(new Headers(options.headers).get("content-type"),"application/x-www-form-urlencoded");const body=new URLSearchParams(String(options.body));requests.push({url:u.pathname,body});
  if(u.pathname==="/oauth/revoke")return new Response(null,{status});
  assert.equal(u.pathname,"/oauth/token");if(status!==200)return new Response("private upstream error",{status});
  token++;return Response.json({access_token:"access-token-"+token,refresh_token:"refresh-token-"+token,token_type:"Bearer",expires_in:expires,scope});
 });
 const before=Date.now(),first=await linearToken("client",{code:"authorization-code",verifier,redirectUri:"https://openreview.example/api/integrations/linear/callback"});
 assert.ok(first.expiresAt>=before+86399*1000);assert.equal(requests[0].body.get("code_verifier"),verifier);assert.equal(requests[0].body.get("grant_type"),"authorization_code");assert.equal(requests[0].body.get("client_secret"),null);
 scope=["read"];const next=await linearToken("client",{refreshToken:first.refreshToken});assert.notEqual(first.refreshToken,next.refreshToken);assert.equal(requests[1].body.get("refresh_token"),first.refreshToken);assert.equal(requests[1].body.get("grant_type"),"refresh_token");
 scope="read write";await assert.rejects(linearToken("client",{refreshToken:next.refreshToken}),/only read scope/);scope="read";
 expires=2592000;await assert.rejects(linearToken("client",{refreshToken:next.refreshToken}));expires=86399;
 status=401;await assert.rejects(linearToken("client",{refreshToken:next.refreshToken}),(e:unknown)=>e instanceof LinearError&&e.status===401&&!e.message.includes("private"));
 for(status of [200,400,401]){await revokeLinear(next);const pair=requests.slice(-2);assert.equal(pair[0].body.get("token_type_hint"),"refresh_token");assert.equal(pair[0].body.get("token"),next.refreshToken);assert.equal(pair[1].body.get("token_type_hint"),"access_token");assert.equal(pair[1].body.get("token"),next.accessToken);assert.equal(pair[1].body.get("access_token"),null);}
 status=503;await assert.rejects(revokeLinear(next),/revocation failed/);
});

test("Linear reads reject partial GraphQL data, stalled discovery, foreign resources and moved issues",async t=>{
 const organization={id:"workspace-one",name:"Acceptance",urlKey:"acceptance"},issue={id:"issue-one",identifier:"PAY-123",team:{id:"team-one"},project:{id:"project-one"},title:"Preserve cents",description:"Amounts must be integer cents.",updatedAt:"2026-10-02T20:00:00.000Z",url:"https://linear.app/acceptance/issue/PAY-123/preserve-cents"};
 let errors=false,status=200,stalled=false,otherOrg=false,moved=false,foreignUrl=false;let contentReads=0;const queries:{query:string;variables:Record<string,unknown>}[]=[];
 t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
  assert.equal(input,"https://api.linear.app/graphql");assert.equal(options.redirect,"error");assert.equal(new Headers(options.headers).get("authorization"),"Bearer fixture-token");assert.equal(options.method,"POST");const request=JSON.parse(String(options.body));queries.push(request);assert.ok(request.query.startsWith("query "));assert.ok(!request.query.includes("mutation"));
  if(status!==200)return new Response("private provider error",{status});
  if(errors)return Response.json({data:{organization},errors:[{message:"private provider error"}]});
  if(request.query.includes("OpenReviewIdentity"))return Response.json({data:{organization,viewer:{id:"viewer-one"}}});
  if(request.query.includes("OpenReviewResources")){
   const teams=request.query.includes("teams("),after=request.variables.after;
   return Response.json({data:{[teams?"teams":"projects"]:{nodes:teams?[{id:after?"team-two":"team-one",name:"Payments",key:"PAY"}]:[{id:"project-one",name:"Cents"}],pageInfo:{hasNextPage:teams&&(!after||stalled),endCursor:teams?"cursor-one":null}}}});
  }
  const content=request.query.includes("description");if(content)contentReads++;
  assert.equal(request.variables.id,content?"issue-one":"PAY-123");
  return Response.json({data:{organization:{id:otherOrg?"workspace-other":organization.id},issue:{...issue,...(content&&moved?{team:{id:"team-other"}}:{}),...(foreignUrl?{url:"https://evil.example/issue/PAY-123"}:{})}}});
 });
 const client=new Linear("fixture-token"),scope={organizationId:organization.id,teamIds:["team-one"],projectIds:["project-one"]};
 assert.deepEqual(await client.identity(),{organization,viewer:{id:"viewer-one"}});const resources=await client.resources();assert.equal(resources.teams.length,2);assert.equal(resources.projects.length,1);
 assert.deepEqual(await client.issue("PAY-123",scope),issue);assert.equal(contentReads,1);
 for(const badScope of [{...scope,organizationId:"other"},{...scope,teamIds:["team-other"]},{...scope,projectIds:["project-other"]}])await assert.rejects(client.issue("PAY-123",badScope),/outside the selected/);assert.equal(contentReads,1);
 const prior=queries.length;await assert.rejects(client.issue("PAY-123",{...scope,teamIds:[]}));await assert.rejects(client.issue('PAY-123") { viewer { id } }',scope));assert.equal(queries.length,prior);
 moved=true;await assert.rejects(client.issue("PAY-123",scope),/moved outside/);moved=false;
 otherOrg=true;await assert.rejects(client.issue("PAY-123",scope),/outside the selected/);otherOrg=false;
 foreignUrl=true;await assert.rejects(client.issue("PAY-123",scope),/Invalid Linear source URL/);foreignUrl=false;
 stalled=true;await assert.rejects(client.resources(),/pagination incomplete/);stalled=false;
 errors=true;await assert.rejects(client.identity(),(e:unknown)=>e instanceof LinearError&&!e.message.includes("private"));errors=false;
 status=401;await assert.rejects(client.identity(),(e:unknown)=>e instanceof LinearError&&e.status===401&&!e.message.includes("private"));
});
