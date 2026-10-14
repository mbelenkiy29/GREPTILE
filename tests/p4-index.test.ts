import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {P4CodeReview} from "../src/perforce";
import {p4SubmittedInventory,parseP4SubmittedInventory} from "../src/p4-index";
import {uploadP4Index,parseP4CliRows} from "../src/perforce-depot";

const project={id:"payments",name:"Payments",branches:[{id:"main",name:"Main",paths:["//depot/main/...","-//depot/main/private/..."]}]};
const source="export const price = 1200;\n";
const record={code:"stat" as const,depotFile:"//depot/main/price.ts",headRev:3,headChange:40,headAction:"edit",headType:"text",fileSize:Buffer.byteLength(source),digest:createHash("md5").update(source).digest("hex")};

test("native P4 -Mj metadata omits stat code while diagnostic records fail closed",()=>{
 assert.deepEqual(parseP4CliRows('{"ServerID":"main","userName":"bot"}\n'),[{code:"stat",ServerID:"main",userName:"bot"}]);
 assert.deepEqual(parseP4CliRows(JSON.stringify(record)),[record]);
 for(const error of [{severity:3,generic:17,data:"No access"},{code:"error"},{data:"warning"}])assert.throws(()=>parseP4CliRows(JSON.stringify(error)));
 assert.throws(()=>parseP4CliRows('{bad JSON'));assert.throws(()=>parseP4CliRows('{"path":"\uFFFD"}'));
});

test("P4 CLI upload sends metadata only to the authenticated origin and rejects redirects, insecure origins and wrong revisions",async()=>{
 const original=globalThis.fetch,inventory=p4SubmittedInventory({project,serverId:"main",change:42,manifest:[record]}),repositoryId="m".repeat(32),config={url:"https://review.example",apiKey:"or_"+"a".repeat(32)};
 const artifact={codeReviewInstance:"https://p4.example",inventory,index:{files:[{content:source}]},ticket:"never upload",skipped:[]};let requests=0,status=202,wrongRevision=false;
 globalThis.fetch=async(input,init)=>{requests++;assert.equal(String(input),"https://review.example/api/p4/index");assert.equal(init?.redirect,"error");assert.equal(init?.method,"POST");assert.equal((init?.headers as Record<string,string>).authorization,"Bearer "+config.apiKey);
  const body=JSON.parse(String(init?.body));assert.deepEqual(Object.keys(body).sort(),["instance","inventory","repositoryId"]);assert.equal(body.instance,artifact.codeReviewInstance);assert.equal(JSON.stringify(body).includes(source),false);assert.equal(JSON.stringify(body).includes("never upload"),false);
  return Response.json({jobId:"job-one",revision:wrongRevision?"wrong":inventory.revision,total:1},{status});
 };
 try{
  assert.equal((await uploadP4Index(artifact,repositoryId,config)).jobId,"job-one");
  const before=requests;
  for(const url of ["http://review.example","https://user:password@review.example","https://review.example/other","https://review.example?secret=key"])await assert.rejects(uploadP4Index(artifact,repositoryId,{...config,url}),/trusted HTTPS origin/);
  await assert.rejects(uploadP4Index({...artifact,inventory:{...inventory,change:43}},repositoryId,config),/revision mismatch/);assert.equal(requests,before);
  status=307;await assert.rejects(uploadP4Index(artifact,repositoryId,config),/307/);status=202;
  wrongRevision=true;await assert.rejects(uploadP4Index(artifact,repositoryId,config),/another inventory revision/);
 }finally{globalThis.fetch=original;}
});

test("submitted P4 inventories reject tampering and ambiguous scope without accepting uploaded source bodies",()=>{
 const input={project,serverId:"main",change:42,manifest:[record,{...record,depotFile:"//depot/main/billing.ts"}]};
 const inventory=p4SubmittedInventory(input);
 assert.deepEqual(parseP4SubmittedInventory(JSON.parse(JSON.stringify(inventory))),inventory);
 assert.equal(p4SubmittedInventory({...input,manifest:[...input.manifest].reverse()}).revision,inventory.revision);
 assert.equal(JSON.stringify(inventory).includes(source),false);
 for(const tamper of [{...inventory,change:43},{...inventory,serverId:"other"},{...inventory,project:{...project,name:"Other"}},{...inventory,manifest:[{...record,headRev:4}]}])assert.throws(()=>parseP4SubmittedInventory(tamper),/revision mismatch/);
 assert.throws(()=>parseP4SubmittedInventory({...inventory,index:{files:[{content:source}]}}));
 const uploadedSource={...record,content:source};assert.throws(()=>p4SubmittedInventory({...input,manifest:[uploadedSource]}));
 assert.throws(()=>p4SubmittedInventory({...input,manifest:[record,record]}),/Duplicate/);
 assert.throws(()=>p4SubmittedInventory({...input,manifest:[{...record,headChange:43}]}),/submitted revision/);
 assert.throws(()=>p4SubmittedInventory({...input,manifest:[{...record,depotFile:"//depot/main/private/secret.ts"}]}),/project views/);
 assert.throws(()=>p4SubmittedInventory({...input,manifest:[{...record,depotFile:"//other/main/price.ts"}]}),/project views/);
 assert.throws(()=>p4SubmittedInventory({...input,project:{...project,deleted:true}}),/Active/);
 assert.throws(()=>p4SubmittedInventory({...input,project:{...project,branches:[{...project.branches[0],paths:["//depot/...@42"]}]}}),/views/);
 assert.throws(()=>p4SubmittedInventory({...input,manifest:Array.from({length:10001},()=>record)}));
});

test("submitted source retrieval pins #revision, verifies independent provider contents, and rejects scope races",async()=>{
 const original=globalThis.fetch,hosts=process.env.SCM_ALLOWED_HOSTS;process.env.SCM_ALLOWED_HOSTS="p4.example";
 let calls=0,reads=0,wrongRevision=false,wrongPath=false,wrongOrigin=false,wrongDigest=false,changedScope=false,invalidEncoding=false;
 globalThis.fetch=async(input,init)=>{
  calls++;const url=new URL(String(input));assert.equal(url.origin,"https://p4.example");assert.equal(init?.redirect,"error");assert.notEqual(init?.method,"POST");
  if(url.pathname==="/api/v9/projects/payments")return Response.json({project:changedScope&&++reads>1?{...project,branches:[{...project.branches[0],paths:["//other/..."]}]}:project});
  if(url.pathname.startsWith("/api/v11/files/")){
   assert.equal(Buffer.from(url.pathname.split("/").at(-1)!,"base64url").toString(),record.depotFile);
   assert.equal(url.searchParams.get("fileRevision"),"#3");
   return Response.json({error:null,data:{filename:wrongPath?"//other/file.ts":record.depotFile,fileRevision:wrongRevision?"@=42":"#3",contentLink:(wrongOrigin?"https://attacker.example":"https://p4.example")+"/view/depot/main/price.ts"}});
  }
  if(url.pathname==="/view/depot/main/price.ts"){assert.equal(url.searchParams.get("v"),"#3");return new Response(invalidEncoding?new Uint8Array([0xff]):wrongDigest?source.replace("1200","1201"):source);}
  throw new Error("Unexpected P4 submitted source request");
 };
 try{
  const client=new P4CodeReview("https://p4.example","bot","fixture-ticket");
  const file=await client.submittedContent(project,record,"main",42);
  assert.equal(file.path,"depot/main/price.ts");assert.equal(file.content,source);assert.equal(file.size,Buffer.byteLength(source));assert.equal(file.sha,`p4:main:3:${record.digest}`);
  const before=calls;
  for(const bad of [{...record,depotFile:"//depot/main/private/secret.ts"},{...record,headChange:43},{...record,headAction:"delete"},{...record,headType:"binary"},{...record,fileSize:200001},{...record,digest:undefined}])await assert.rejects(client.submittedContent(project,bad,"main",42));
  assert.equal(calls,before);
  wrongRevision=true;await assert.rejects(client.submittedContent(project,record,"main",42),/metadata revision/);wrongRevision=false;
  wrongPath=true;await assert.rejects(client.submittedContent(project,record,"main",42),/metadata revision/);wrongPath=false;
  wrongOrigin=true;await assert.rejects(client.submittedContent(project,record,"main",42),/trusted file origin/);wrongOrigin=false;
  wrongDigest=true;await assert.rejects(client.submittedContent(project,record,"main",42),/digest changed/);wrongDigest=false;
  changedScope=true;reads=0;await assert.rejects(client.submittedContent(project,record,"main",42),/views changed during/);changedScope=false;
  // The digest can agree with invalid bytes; fatal decoding must still reject them.
  invalidEncoding=true;const badBytes=new Uint8Array([0xff]);await assert.rejects(client.submittedContent(project,{...record,fileSize:1,digest:createHash("md5").update(badBytes).digest("hex")},"main",42),/encoded data/);
 }finally{globalThis.fetch=original;if(hosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=hosts;}
});
