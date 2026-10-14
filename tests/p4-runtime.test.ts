import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { P4CodeReview, type P4Snapshot } from "../src/perforce";
import { p4SubmittedInventory } from "../src/p4-index";
import { p4RuntimeArchive, runtimeTar } from "../src/p4-runtime";
import { runtimeEvidenceSchema } from "../src/engine/types";
import { runtimeRevisionSchema } from "../src/runtime-revision";
const project={id:"fixture",name:"Fixture",branches:[{id:"main",name:"Main",paths:["//depot/main/..."]}]};
const digest=(b:Uint8Array)=>createHash("md5").update(b).digest("hex");
const revision="p4:7:1:8:"+"a".repeat(64);
function fixture(t:test.TestContext){
 process.env.SCM_ALLOWED_HOSTS="p4.example";
 const old=Buffer.from("original"),binary=Buffer.from([0,255,128,1]),next=Buffer.from("updated"),added=Buffer.from("new");
 const record=(path:string,bytes:Buffer,type="text")=>({code:"stat" as const,depotFile:"//depot/main/"+path,headRev:1,headChange:5,headAction:"add",headType:type,fileSize:bytes.length,digest:digest(bytes)});
 const inventory=p4SubmittedInventory({project,serverId:"fixture",change:5,manifest:[record("run.sh",old,"text+x"),record("asset.bin",binary,"binary"),record("gone.txt",old)]});
 const snapshot:P4Snapshot={projectId:project.id,review:{id:7,author:"alice",description:"Archive",updated:1,pending:true,state:"needsReview",projects:{fixture:["main"]},versions:[{change:7,archiveChange:8,pending:true,time:1}]},version:1,change:8,revision,coverage:[],files:[{depotFile:"//depot/main/run.sh",rev:1,action:"edit",type:"text+x",fileSize:next.length,digest:digest(next)},{depotFile:"//depot/main/gone.txt",rev:1,action:"delete",type:"text"},{depotFile:"//depot/main/new.txt",rev:0,action:"add",type:"text",fileSize:added.length,digest:digest(added)}]};
 const client=new P4CodeReview("https://p4.example","bot","fixture-ticket"),reads:{path:string;rev:string}[]=[];
 t.mock.method(client,"project",async()=>project);t.mock.method(client,"snapshot",async()=>snapshot);
 t.mock.method(client,"runtimeBytes",async(_p:unknown,path:string,rev:string)=>{reads.push({path,rev});return path.endsWith("asset.bin")?binary:path.endsWith("new.txt")?added:next;});
 return {client,inventory,snapshot,reads,binary,next};
}
test("P4 runtime overlays exact raw shelf files on the selected baseline, including binaries and executable modes",async t=>{
 const f=fixture(t),archive=await p4RuntimeArchive(f.client,f.inventory,f.snapshot);
 const list=spawnSync("tar",["-tzf","-"],{input:archive,encoding:"utf8"});assert.equal(list.status,0);assert.deepEqual(list.stdout.trim().split("\n").sort(),["source/depot/main/asset.bin","source/depot/main/new.txt","source/depot/main/run.sh"]);
 assert.deepEqual(spawnSync("tar",["-xzOf","-","source/depot/main/asset.bin"],{input:archive}).stdout,f.binary);
 assert.deepEqual(spawnSync("tar",["-xzOf","-","source/depot/main/run.sh"],{input:archive}).stdout,f.next);
 assert.match(spawnSync("tar",["-tvzf","-"],{input:archive,encoding:"utf8"}).stdout,/-rwxr-xr-x.*run.sh/);
 assert.deepEqual(f.reads.sort((a,b)=>a.path.localeCompare(b.path)),[{path:"//depot/main/run.sh",rev:"@=8"},{path:"//depot/main/asset.bin",rev:"#1"},{path:"//depot/main/new.txt",rev:"@=8"}].sort((a,b)=>a.path.localeCompare(b.path)));
});
test("P4 archives fail visibly for changed shelves, project scope, missing metadata and unsupported file semantics",async t=>{
 const f=fixture(t);t.mock.method(f.client,"snapshot",async()=>({...f.snapshot,revision:"p4:7:2:9:"+"b".repeat(64)}));await assert.rejects(p4RuntimeArchive(f.client,f.inventory,f.snapshot),/shelf or project changed/);
 t.mock.method(f.client,"project",async()=>({...project,name:"Changed"}));await assert.rejects(p4RuntimeArchive(f.client,f.inventory,f.snapshot),/baseline project/);
 t.mock.method(f.client,"project",async()=>project);
 await assert.rejects(p4RuntimeArchive(f.client,f.inventory,{...f.snapshot,files:[{...f.snapshot.files[0],digest:undefined}]}),/metadata/);
 await assert.rejects(p4RuntimeArchive(f.client,f.inventory,{...f.snapshot,files:[{...f.snapshot.files[0],type:"symlink"}]}),/metadata/);
 await assert.rejects(p4RuntimeArchive(f.client,f.inventory,{...f.snapshot,files:[{...f.snapshot.files[0],fileSize:20000001}]}),/20 MB/);
 for(const path of ["/absolute","../escape","a/../escape","a\\escape"]){assert.throws(()=>runtimeTar([{path,bytes:Buffer.alloc(0),executable:false}]),/archive path/);}
 assert.throws(()=>runtimeTar([{path:"same",bytes:Buffer.alloc(0),executable:false},{path:"same",bytes:Buffer.alloc(0),executable:false}]),/duplicate/);
});
test("P4 raw runtime retrieval binds authentication, native revision, project and byte digest without text conversion",async t=>{
 process.env.SCM_ALLOWED_HOSTS="p4.example";const bytes=Buffer.from([255,0,128]),client=new P4CodeReview("https://p4.example","bot","fixture-ticket");let corrupted=false;
 t.mock.method(globalThis,"fetch",async(input:URL|string,options?:RequestInit)=>{
  const url=new URL(String(input));assert.equal(options?.redirect,"error");assert.equal(new Headers(options?.headers).get("authorization"),"Basic "+Buffer.from("bot:fixture-ticket").toString("base64"));
  if(url.pathname==="/api/v9/projects/fixture")return Response.json({project});
  if(url.pathname.startsWith("/api/v11/files/")){assert.equal(url.searchParams.get("fileRevision"),"#2");return Response.json({error:null,data:{filename:"//depot/main/asset.bin",fileRevision:"#2",contentLink:"https://p4.example/view/depot/main/asset.bin"}});}
  assert.equal(url.pathname,"/view/depot/main/asset.bin");assert.equal(url.searchParams.get("v"),"#2");return new Response(corrupted?Buffer.from([1,2,3]):bytes);
 });
 assert.deepEqual(Buffer.from(await client.runtimeBytes(project,"//depot/main/asset.bin","#2",bytes.length,digest(bytes))),bytes);
 corrupted=true;await assert.rejects(client.runtimeBytes(project,"//depot/main/asset.bin","#2",bytes.length,digest(bytes)),/digest/);
 await assert.rejects(client.runtimeBytes(project,"//other/asset.bin","#2",bytes.length,digest(bytes)),/project views/);
});
test("execution evidence accepts native shelf identities and rejects branch names or manufactured identities",()=>{
 assert.equal(runtimeRevisionSchema.parse(revision),revision);
 for(const invalid of ["main","p4:7:1:8:short","p4:0:1:8:"+"a".repeat(64)])assert.equal(runtimeRevisionSchema.safeParse(invalid).success,false);
 assert.equal(runtimeEvidenceSchema.parse({headSha:revision,image:"node@sha256:"+"a".repeat(64),command:"node --test",exitCode:0,timedOut:false,executionStarted:true,output:"",outputTruncated:false,network:"none",memoryMb:512,cpus:1}).headSha,revision);
});
