import test from "node:test";
import assert from "node:assert/strict";
import { runtimeWorker } from "../scripts/runtime-worker";
test("runtime worker restricts transport, heartbeats during active work, and retries reporting without executing twice",{timeout:45000},async t=>{
 const credential="orw_"+"a".repeat(64);
 await assert.rejects(runtimeWorker("http://untrusted.example",credential,true),/HTTPS/);
 await assert.rejects(runtimeWorker("https://backend.example","invalid",true),/credential/);
 let claims=0,reports=0;
 t.mock.method(globalThis,"fetch",async(input:URL,options:RequestInit)=>{
  assert.equal(options.redirect,"error");assert.equal(new Headers(options.headers).get("authorization"),"Bearer "+credential);
  if(input.pathname.endsWith("claim")){claims++;return Response.json({id:"job-fixture",headSha:"a".repeat(40),repository:"fixture/repo",image:"unapproved-image",command:"node --test",timeout:1});}
  if(input.pathname.endsWith("snapshot"))return new Response("archive-fixture");
  reports++;const body=JSON.parse(String(options.body));assert.match(body.error,/pinned/);assert.equal(body.evidence,undefined);
  return reports===1?new Response("temporary outage",{status:503}):Response.json({ok:true});
 });
 await runtimeWorker("http://127.0.0.1:3211",credential,true);
 assert.equal(claims,1);assert.equal(reports,2);
 let heartbeats=0,finishSnapshot!:()=>void,snapshotStarted!:()=>void,heartbeatSent!:()=>void;
 const snapshotReady=new Promise<void>(resolve=>{snapshotStarted=resolve;}),heartbeatReady=new Promise<void>(resolve=>{heartbeatSent=resolve;});
 const snapshotGate=new Promise<void>(resolve=>{finishSnapshot=resolve;});
 t.mock.method(globalThis,"fetch",async(input:URL,options:RequestInit)=>{
  if(input.pathname.endsWith("claim")){claims++;return Response.json({id:"busy-job",headSha:"a".repeat(40),repository:"fixture/repo",image:"unapproved-image",command:"node --test",timeout:120});}
  if(input.pathname.endsWith("snapshot")){snapshotStarted();await snapshotGate;return new Response("archive-fixture");}
  if(input.pathname.endsWith("heartbeat")){heartbeats++;assert.equal(JSON.parse(String(options.body)).id,"busy-job");heartbeatSent();return Response.json({ok:true});}
  reports++;return Response.json({ok:true});
 });
 const busy=runtimeWorker("http://127.0.0.1:3211",credential,true);
 await snapshotReady;await heartbeatReady;
 finishSnapshot();await busy;
 assert.equal(heartbeats,1);assert.equal(claims,2);assert.equal(reports,3);
 assert.equal(heartbeats,1,"Heartbeat stopped after reporting");
});

test('supervisor exit codes separate credential/configuration rejection from recoverable transport errors',async t=>{
 const {runtimeWorkerExitCode}=await import('../scripts/runtime-worker'),credential='orw_'+'a'.repeat(64);
 for(const url of ['', 'http://untrusted.example', 'https://user:password@backend.example']){
  try{await runtimeWorker(url,credential,true);assert.fail('Expected configuration rejection');}catch(error){assert.equal(runtimeWorkerExitCode(error),78);}
 }
 t.mock.method(globalThis,'fetch',async()=>Response.json({code:'worker_credential_rejected'},{status:401}));
 try{await runtimeWorker('http://127.0.0.1:3211',credential,true);assert.fail('Expected credential rejection');}catch(error){assert.equal(runtimeWorkerExitCode(error),78);}
 for(const response of [Response.json({error:'Expired job lease'},{status:401}),new Response('temporary outage',{status:503})]){
  t.mock.method(globalThis,'fetch',async()=>response.clone());
  try{await runtimeWorker('http://127.0.0.1:3211',credential,true);assert.fail('Expected transport rejection');}catch(error){assert.equal(runtimeWorkerExitCode(error),1);}
 }
});

test('revoked credentials during reporting stop retries and the CLI exposes terminal exit 78 without the token',async t=>{
 const credential='orw_'+'a'.repeat(64);let reports=0;
 t.mock.method(globalThis,'fetch',async(input:URL)=>{
  if(input.pathname.endsWith('claim'))return Response.json({id:'job-revoked',headSha:'a'.repeat(40),repository:'fixture/repo',image:'unapproved-image',command:'node --test',timeout:1});
  if(input.pathname.endsWith('snapshot'))return new Response('archive-fixture');
  reports++;return Response.json({code:'worker_credential_rejected'},{status:401});
 });
 await assert.rejects(runtimeWorker('http://127.0.0.1:3211',credential,true),/expired or revoked/);assert.equal(reports,1);
 const {createServer}=await import('node:http'),{spawn}=await import('node:child_process');
 const server=createServer((_request,response)=>{response.writeHead(401,{'content-type':'application/json'});response.end(JSON.stringify({code:'worker_credential_rejected'}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const child=spawn(process.execPath,['--import','tsx','scripts/runtime-worker.ts','--once'],{env:{NODE_ENV:"test",PATH:process.env.PATH,OPENREVIEW_WORKER_URL:'http://127.0.0.1:'+address.port,OPENREVIEW_WORKER_TOKEN:credential},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,78);assert.match(stderr,/expired or revoked/);assert.ok(!stderr.includes(credential));
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('revocation heartbeat cancels active snapshot and exits without reporting an execution result',{timeout:40000},async t=>{
 const credential='orw_'+'b'.repeat(64);let reports=0,snapshotAborted=false;
 t.mock.method(globalThis,'fetch',async(input:URL,options:RequestInit)=>{
  if(input.pathname.endsWith('claim'))return Response.json({id:'revoked-active',headSha:'a'.repeat(40),repository:'fixture/repo',image:'node@sha256:'+'a'.repeat(64),command:'node --test',timeout:120});
  if(input.pathname.endsWith('snapshot'))return new Promise<Response>((_resolve,reject)=>{
   const signal=options.signal!;signal.addEventListener('abort',()=>{snapshotAborted=true;reject(signal.reason);},{once:true});
  });
  if(input.pathname.endsWith('heartbeat'))return Response.json({code:'worker_credential_rejected'},{status:401});
  reports++;return Response.json({ok:true});
 });
 const {runtimeWorkerExitCode}=await import('../scripts/runtime-worker');
 try{await runtimeWorker('http://127.0.0.1:3211',credential,true);assert.fail('Expected active credential rejection');}
 catch(error){assert.equal(runtimeWorkerExitCode(error),78);assert.match(String(error),/expired or revoked/);assert.ok(!String(error).includes(credential));}
 assert.equal(snapshotAborted,true);assert.equal(reports,0,'No evidence is reported after revocation');
});

test('snapshot credential rejection terminates without retrying or reporting',async t=>{
 let requests=0;
 t.mock.method(globalThis,'fetch',async(input:URL)=>{
  requests++;
  if(input.pathname.endsWith('claim'))return Response.json({id:'revoked-snapshot',headSha:'a'.repeat(40),repository:'fixture/repo',image:'node@sha256:'+'a'.repeat(64),command:'node --test',timeout:120});
  assert.ok(input.pathname.endsWith('snapshot'));
  return Response.json({code:'worker_credential_rejected'},{status:401});
 });
 const {runtimeWorkerExitCode}=await import('../scripts/runtime-worker');
 try{await runtimeWorker('http://127.0.0.1:3211','orw_'+'c'.repeat(64),true);assert.fail('Expected rejection');}
 catch(error){assert.equal(runtimeWorkerExitCode(error),78);}
 assert.equal(requests,2);
});
