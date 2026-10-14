import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {latestP4SubmittedChange,syncP4Index} from "../src/perforce-depot";
import {p4SubmittedInventory} from "../src/p4-index";

test("P4 watcher discovers native submitted revisions, uploads metadata only, and skips busy or unchanged indexes",async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),"openreview-watch-test-")),priorPath=process.env.PATH,priorHosts=process.env.SCM_ALLOWED_HOSTS;
 const modePath=path.join(directory,"mode"),callsPath=path.join(directory,"calls");
 const native={server:"ssl:p4.example:1666",serverId:"main",username:"bot",ticket:"fixture-ticket"};
 const project={id:"payments",name:"Payments",branches:[{id:"main",name:"Main",paths:["//depot/main/..."]}]};
 const record={code:"stat" as const,depotFile:"//depot/main/price.ts",headRev:3,headChange:42,headAction:"edit",headType:"text",fileSize:10,digest:"a".repeat(32)};
 const inventory=p4SubmittedInventory({project,serverId:"main",change:44,manifest:[record]});
 await writeFile(modePath,"normal");await writeFile(path.join(directory,"p4"),`#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2),mode=fs.readFileSync(${JSON.stringify(modePath)},'utf8');
assert.deepEqual(args.slice(0,6),['-p','ssl:p4.example:1666','-u','bot','-Mj','-ztag']);assert.equal(process.env.P4PASSWD,'fixture-ticket');assert.equal(process.env.P4CONFIG,'');assert.equal(fs.existsSync(process.env.P4TICKETS),false);
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+'\\n');const row=v=>console.log(JSON.stringify(v));
if(args[6]==='info')row({ServerID:mode==='identity'?'foreign':'main',userName:'bot'});
else if(args[6]==='changes'){assert.deepEqual(args.slice(6),['changes','-s','submitted','-m','1','//depot/main/...']);if(mode==='empty'){}else if(mode==='diagnostic')row({severity:3,data:'denied'});else row({change:'44',status:mode==='pending'?'pending':'submitted'});}
else if(args[6]==='change')row({Change:'44',Status:'submitted'});
else if(args[6]==='fstat'){assert.equal(args.at(-1),'//depot/main/...@44');row(${JSON.stringify(record)});}
else throw new Error('Unexpected write or source read');
`,{mode:0o700});
 process.env.PATH=directory+path.delimiter+priorPath;process.env.SCM_ALLOWED_HOSTS="p4.example";
 const repositoryId="m".repeat(32),hosted={url:"https://review.example",apiKey:"or_"+"a".repeat(32)};
 let status="not_indexed",revision:string|null=null,projectId="payments",denied=false,uploads=0;
 t.mock.method(globalThis,"fetch",async(raw:unknown,options:RequestInit)=>{
  const url=new URL(String(raw));assert.equal(options.redirect,"error");
  if(url.origin==="https://p4.example"){assert.equal(url.pathname,"/api/v9/projects/payments");assert.notEqual(options.method,"POST");return Response.json({project});}
  assert.equal(url.origin,"https://review.example");assert.equal(url.pathname,"/api/p4/index");assert.equal(new Headers(options.headers).get("authorization"),"Bearer "+hosted.apiKey);
  if(options.method==="POST"){uploads++;const body=JSON.parse(String(options.body));assert.deepEqual(body,{repositoryId,instance:"https://p4.example",inventory});assert.equal(JSON.stringify(body).includes(native.ticket),false);return Response.json({jobId:"job1",revision:inventory.revision,total:1});}
  assert.equal(url.searchParams.get("repositoryId"),repositoryId);return denied?new Response(null,{status:403}):Response.json({repositoryId,projectId,instance:"https://p4.example",indexStatus:status,revision,error:null});
 });
 const input={repositoryId,instance:"https://p4.example",projectId:"payments",native,hosted};
 try{
  assert.equal(await latestP4SubmittedChange(project,native),44);
  assert.deepEqual(await syncP4Index(input),{status:"queued",jobId:"job1",revision:inventory.revision,total:1,change:44});assert.equal(uploads,1);
  status="ready";revision=inventory.revision;assert.equal((await syncP4Index(input)).status,"unchanged");assert.equal(uploads,1);
  const calls=await readFile(callsPath,"utf8");status="indexing";assert.equal((await syncP4Index(input)).status,"busy");assert.equal(await readFile(callsPath,"utf8"),calls);
  status="failed";await assert.rejects(syncP4Index(input),/explicitly retry/);assert.equal(await readFile(callsPath,"utf8"),calls);
  status="ready";projectId="wrong";await assert.rejects(syncP4Index(input),/another project/);assert.equal(await readFile(callsPath,"utf8"),calls);projectId="payments";
  denied=true;await assert.rejects(syncP4Index(input),/access rejected/);assert.equal(await readFile(callsPath,"utf8"),calls);denied=false;
  for(const mode of ["identity","empty","pending","diagnostic"]){await writeFile(modePath,mode);await assert.rejects(latestP4SubmittedChange(project,native));}
  await assert.rejects(latestP4SubmittedChange({...project,branches:[{...project.branches[0],paths:["//depot/...@forged"]}]},native));
  assert.equal(calls.includes(native.ticket),false);assert.equal(calls.includes('"print"'),false);
 }finally{if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;if(priorHosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=priorHosts;await rm(directory,{recursive:true,force:true});}
});
