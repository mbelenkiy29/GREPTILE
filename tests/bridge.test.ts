import test from "node:test";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import { agentCommand, bridgeUrl, remoteIdentity, requestId, resolveCursorAgent, resolveCodexAgent } from "../src/bridge";
import { protocolFiles, desktopExecArgument } from "../src/bridge-install";
import { reviewSummarySchema } from "../src/engine/review";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
test("bridge links and fixed adapters reject content as executable instructions",()=>{
 assert.equal(requestId("openreview://fix?request=abcdefghijklmnop"),"abcdefghijklmnop");
 for(const url of ["openreview://fix?request=short","openreview://fix?request=abcdefghijklmnop&cmd=rm","openreview://evil?request=abcdefghijklmnop","openreview://fix/path?request=abcdefghijklmnop","openreview://fix?request=abcdefghijklmnop#x"])assert.throws(()=>requestId(url));
 assert.equal(remoteIdentity("git@github.com:alice/example.git"),remoteIdentity("https://github.com/alice/example"));
 assert.equal(bridgeUrl("http://localhost:3000"),"http://localhost:3000");
 for(const url of ["http://review.example.com","https://user:pass@example.com","https://example.com/path"])assert.throws(()=>bridgeUrl(url));
 for(const agent of ["codex","claude","cursor"]){const command=agentCommand(agent,"$(touch /tmp/injected)","/tmp/repo with spaces");assert.equal(command.file,agent);assert.ok(command.args.includes("$(touch /tmp/injected)"));}
 assert.throws(()=>agentCommand("sh","x","/tmp"));
 assert.ok(protocolFiles("darwin","/tmp/openreview","/tmp/cli.mjs","/usr/bin/node").content.includes("applicationWillFinishLaunching"));
 for(const platform of ["darwin","win32","linux"]){const file=protocolFiles(platform,"/tmp/openreview","/tmp/openreview/bin/cli.mjs","/usr/bin/node");assert.ok(file.content.includes("dispatch"));assert.ok(file.content.length>100);}
});
test("Linux launcher uses desktop quoting and retains only its explicit URI field code",()=>{
 const entry=protocolFiles("linux","/tmp/bridge",'/tmp/$cash`quoted"percent%u cli.mjs',"/usr/bin/node").content;
 assert.ok(entry.includes('percent%%u cli.mjs'));
 assert.ok(entry.includes('\\\\$cash\\\\`quoted\\\\"'));
 assert.ok(entry.includes('bridge dispatch --desktop %u\n'));
 assert.equal(desktopExecArgument('a\\b'),'"a\\\\\\\\b"');
 for(const bad of ['x\ny','x\ry','x\0y'])assert.throws(()=>protocolFiles("linux","/tmp",bad,"/usr/bin/node"),/control characters/);
 assert.throws(()=>protocolFiles("linux","/tmp","/tmp/cli.mjs","/tmp/node=bad"),/equals sign/);
});
test('Cursor adapters recognize the official standalone CLI and retain desktop fallback',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'openreview-cursor-'));
 const env:NodeJS.ProcessEnv={PATH:root,NODE_ENV:'test'};
 try{
  // Help-only fixtures: no authentication or inference.
  await writeFile(path.join(root,'cursor-agent'),'#!/bin/sh\n[ "$1" = "--help" ] || exit 99\nexit 0\n',{mode:0o700});
  assert.equal(await resolveCursorAgent(env),'cursor-agent');
  assert.deepEqual(agentCommand('cursor','$(touch /tmp/injected)','/tmp/repo','cursor-agent'),{file:'cursor-agent',args:['$(touch /tmp/injected)']});
  await writeFile(path.join(root,'cursor'),'#!/bin/sh\n[ "$1" = "agent" ] && [ "$2" = "--help" ] || exit 99\nexit 0\n',{mode:0o700});
  assert.equal(await resolveCursorAgent(env),'cursor-agent');
  await rm(path.join(root,'cursor-agent'));
  assert.equal(await resolveCursorAgent(env),'cursor');
  assert.deepEqual(agentCommand('cursor','literal prompt','/tmp/repo','cursor'),{file:'cursor',args:['agent','literal prompt']});
  await rm(path.join(root,'cursor'));
  await writeFile(path.join(root,'agent'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  await assert.rejects(resolveCursorAgent(env),/Cursor Agent.*not available/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Windows Codex npm fallback launches its fixed JS entry without a command shell',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'openreview-windows-codex-'));
 const installed=path.join(root,'node_modules','@openai','codex'),script=path.join(installed,'bin','codex.js');
 const env:NodeJS.ProcessEnv={PATH:root,NODE_ENV:'test'};
 try{
  await mkdir(path.dirname(script),{recursive:true});
  await writeFile(path.join(root,'codex.cmd'),'@echo off\r\nexit /b 99\r\n');
  await writeFile(path.join(installed,'package.json'),JSON.stringify({name:'@openai/codex',type:'module'}));
  await writeFile(script,'console.log(JSON.stringify(process.argv.slice(2)))');
  const adapter=await resolveCodexAgent(env,'win32');
  assert.equal(adapter.file,process.execPath);assert.deepEqual(adapter.prefix,[await realpath(script)]);
  const prompt='$(touch injected) & echo unsafe | more',command=agentCommand('codex',prompt,'C:\\repo with spaces');
  const result=await promisify(execFile)(adapter.file,[...adapter.prefix,...command.args],{env});
  assert.deepEqual(JSON.parse(result.stdout),['-C','C:\\repo with spaces',prompt]);
  await writeFile(path.join(installed,'package.json'),JSON.stringify({name:'unrelated-package'}));
  await assert.rejects(resolveCodexAgent(env,'win32'),/Codex is not available/);
  assert.deepEqual(await resolveCodexAgent(env,'linux'),{file:'codex',prefix:[]});
 }finally{await rm(root,{recursive:true,force:true});}
});
// Single-quoted POSIX shell literal.
const sh=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
test("dispatch records agent exit failures and signals without treating launch as resolution",async()=>{
 const execute=promisify(execFile),root=await mkdtemp(path.join(tmpdir(),"openreview-bridge-"));
 const repo=path.join(root,"repo"),bin=path.join(root,"bin"),home=path.join(root,"bridge");
 const reports:Array<{status:string;error?:string}>=[];
 let head="",rejectLaunchOnce=false,rejectFinished=false,selectedAgent='codex';let nativeTask:Record<string,unknown>|undefined;
 const server=createServer(async(req,res)=>{
  let body="";for await(const chunk of req)body+=chunk;
  assert.equal(req.headers.authorization,"Bearer obr_"+"a".repeat(64));
  if(req.url==="/api/bridge/claim")res.end(JSON.stringify({requestId:JSON.parse(body).requestId,repository:"alice/example",headSha:head,agent:selectedAgent,prompt:"Inspect the evidence and preserve unrelated changes.",...(nativeTask?{native:nativeTask}:{})}));
  else {assert.equal(req.url,"/api/bridge/report");const report=JSON.parse(body);reports.push(report);if(report.status==="launched"&&rejectLaunchOnce){rejectLaunchOnce=false;res.writeHead(503);}else if(report.status==="finished"&&rejectFinished)res.writeHead(503);res.end("{}");}
 });
 try{
  await Promise.all([mkdir(repo),mkdir(bin),mkdir(home)]);
  await symlink((await execute("which",["git"])).stdout.trim(),path.join(bin,"git"));
  await execute("git",["init",repo]);await execute("git",["-C",repo,"-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-m","Acceptance"]);
  await execute("git",["-C",repo,"remote","add","origin","https://github.com/alice/example.git"]);
  head=(await execute("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim();
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  await writeFile(path.join(home,"config.json"),JSON.stringify({url:`http://127.0.0.1:${address.port}`,token:"obr_"+"a".repeat(64),repositories:{"github.com/alice/example":repo}}),{mode:0o600});
  // Fake agents are POSIX shell scripts, not Node scripts. With system CAs enabled
  // (NODE_USE_SYSTEM_CA=1 or --use-system-ca), Node 24 before 24.9 loads certificates on a thread at
  // startup, and a process.exit() that races it intermittently dies with SIGSEGV/SIGBUS
  // (nodejs/node#59856), which the dispatcher would then correctly report as the agent's status.
  for(const [index,script] of ["exit 0","exit 7","kill -TERM $$",null].entries()){
   reports.length=0;
   if(script===null)await rm(path.join(bin,"codex"));else await writeFile(path.join(bin,"codex"),`#!/bin/sh\n${script}\n`,{mode:0o700});
   const run=execute(process.execPath,[path.resolve("bin/openreview.mjs"),"bridge","dispatch",`openreview://fix?request=abcdefghijklmnop${index}`],{env:{...process.env,OPENREVIEW_BRIDGE_HOME:home,PATH:script===null?bin:bin+path.delimiter+process.env.PATH},timeout:15000});
   if(index===0){await run;assert.deepEqual(reports.map(r=>r.status),["launched","finished"]);}
   else if(index===3){await assert.rejects(run);assert.deepEqual(reports.map(r=>r.status),["failed"]);assert.match(reports[0].error!,/ENOENT/);}
   else {await assert.rejects(run);assert.deepEqual(reports.map(r=>r.status),["launched","failed"]);assert.match(reports[1].error!,index===1?/code 7/:/signal SIGTERM/);}
  }
  for(const mode of ['launch-report','finished-report']){
   reports.length=0;rejectLaunchOnce=mode==='launch-report';rejectFinished=mode==='finished-report';
   const marker=path.join(repo,'agent-completed-'+mode);await writeFile(path.join(bin,'codex'),`#!/bin/sh\nsleep 0.15\nprintf done > ${sh(marker)}\n`,{mode:0o700});
   const run=execute(process.execPath,[path.resolve('bin/openreview.mjs'),'bridge','dispatch','openreview://fix?request=abcdefghijklmnop'+mode.replaceAll('-','')],{env:{...process.env,OPENREVIEW_BRIDGE_HOME:home,PATH:bin+path.delimiter+process.env.PATH},timeout:15000});
   if(mode==='launch-report'){await run;assert.deepEqual(reports.map(r=>r.status),['launched','launched','finished']);}
   else {await assert.rejects(run,/successfully.*status.*confirmed/);assert.deepEqual(reports.map(r=>r.status),['launched','finished']);}
   const {readFile}=await import('node:fs/promises');assert.equal(await readFile(marker,'utf8'),'done');
  }
  rejectFinished=false;
  selectedAgent='cursor';
  for(const adapter of ['cursor-agent','cursor']){
   const marker=path.join(repo,'cursor-argv-'+adapter);
   // Records its argv NUL-separated (any characters survive) unless it is the --help probe.
   await writeFile(path.join(bin,adapter),`#!/bin/sh\nfor a in "$@"; do [ "$a" = "--help" ] && exit 0; done\nprintf '%s\\0' "$@" > ${sh(marker)}\n`,{mode:0o700});
   reports.length=0;
   await execute(process.execPath,[path.resolve('bin/openreview.mjs'),'bridge','dispatch','openreview://fix?request=abcdefghijklmnop'+adapter.replaceAll('-','')],{env:{...process.env,OPENREVIEW_BRIDGE_HOME:home,PATH:bin},timeout:15000});
   const {readFile}=await import('node:fs/promises');const argv=(await readFile(marker,'utf8')).split('\0').slice(0,-1);
   assert.equal(argv.length,adapter==='cursor'?2:1);if(adapter==='cursor')assert.equal(argv[0],'agent');
   assert.match(argv.at(-1)!,/Read the fix request at/);assert.deepEqual(reports.map(r=>r.status),['launched','finished']);
   await rm(path.join(bin,adapter));
  }
  selectedAgent='codex';
  const nativeRoot=await realpath(repo),source='export const cents = 199;\n',file=path.join(nativeRoot,'price.ts');await writeFile(file,source);
  head='p4:12:1:14:'+ 'a'.repeat(64);nativeTask={instance:'https://p4.example',project:'payments',serverId:'native-server',files:[{depotFile:'//depot/main/price.ts',haveRevision:1,revision:'@=14',digest:createHash('md5').update(source).digest('hex'),fileSize:Buffer.byteLength(source)}]};
  await writeFile(path.join(home,'config.json'),JSON.stringify({url:`http://127.0.0.1:${address.port}`,token:'obr_'+'a'.repeat(64),p4Repositories:{'p4:https://p4.example:payments':{root:nativeRoot,server:'ssl:p4.example:1666',serverId:'native-server',client:'native-client',username:'author'}}}));
  // Fake p4: the first of info/client/fstat/print among its arguments selects the JSON row it prints.
  const rows={info:{ServerID:'native-server',userName:'author',clientName:'native-client'},client:{Client:'native-client',Root:nativeRoot,Owner:'author',LineEnd:'unix',Options:'noallwrite noclobber'},fstat:{depotFile:'//depot/main/price.ts',clientFile:file,haveRev:'1'}};
  await writeFile(path.join(bin,'p4'),`#!/bin/sh\ncmd=\nfor c in info client fstat print; do for a in "$@"; do [ "$a" = "$c" ] && cmd=$c && break 2; done; done\ncase "$cmd" in\n${Object.entries(rows).map(([cmd,row])=>`${cmd}) printf '%s\\n' ${sh(JSON.stringify(row))};;`).join('\n')}\nprint) printf '%s' ${sh(source)};;\n*) exit 9;;\nesac\n`,{mode:0o700});
  await writeFile(path.join(bin,'codex'),`#!/bin/sh\n[ "$P4PORT" = 'ssl:p4.example:1666' ] && [ "$P4CLIENT" = 'native-client' ] && [ "$P4USER" = 'author' ] || exit 9\nexit 0\n`,{mode:0o700});
  reports.length=0;await execute(process.execPath,[path.resolve('bin/openreview.mjs'),'bridge','dispatch','openreview://fix?request=abcdefghijklmnopnative'],{env:{...process.env,OPENREVIEW_BRIDGE_HOME:home,PATH:bin+path.delimiter+process.env.PATH},timeout:15000});assert.deepEqual(reports.map(r=>r.status),['launched','finished']);
  await writeFile(file,'unrelated existing work');reports.length=0;await assert.rejects(execute(process.execPath,[path.resolve('bin/openreview.mjs'),'bridge','dispatch','openreview://fix?request=abcdefghijklmnopstale'],{env:{...process.env,OPENREVIEW_BRIDGE_HOME:home,PATH:bin+path.delimiter+process.env.PATH},timeout:15000}));assert.deepEqual(reports.map(r=>r.status),['failed']);assert.match(reports[0].error!,/preserve the changes/);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test("test-source prose cannot claim execution without runtime evidence",()=>{
 for(const summary of ["Browser-driven tests confirm the new invoice flow behaves correctly.","The test suite passed with all regression checks.","We ran tests for the corrected checkout logic.","Addition of a passing test that would fail if cents/dollars were confused.","The change includes successful regression tests."]){assert.equal(reviewSummarySchema(undefined).safeParse({summary}).success,false);}
 assert.equal(reviewSummarySchema(undefined).safeParse({summary:"Test source adds cases covering the invoice flow. Execution was not performed."}).success,true);
 assert.equal(reviewSummarySchema(undefined).safeParse({summary:"The regression tests were not executed by OpenReview."}).success,true);
 assert.equal(reviewSummarySchema(undefined).safeParse({summary:"Tests passed, but browser tests were not executed."}).success,false);
 assert.equal(reviewSummarySchema(undefined).safeParse({summary:"No evidence of test execution are supplied or verified."}).success,true);
 assert.equal(reviewSummarySchema(undefined).safeParse({summary:"Test files and CI metadata are context, not proof of a successful test run."}).success,true);
 assert.equal(reviewSummarySchema(undefined).safeParse({summary:"No evidence of test execution was supplied, but tests passed."}).success,false);

});

test('bridge status keeps local diagnostics available for unpaired, rejected and malformed configurations',async()=>{
 const execute=promisify(execFile),root=await mkdtemp(path.join(tmpdir(),'openreview-status-')),home=path.join(root,'bridge'),bin=path.join(root,'bin');
 await mkdir(home);await mkdir(bin);
 // These are --help-only contract fixtures, not coding-agent launch evidence.
 const fixture=path.join(bin,'codex');await writeFile(fixture,'#!/bin/sh\n[ "$1" = "--help" ] || exit 99\nexit 0\n',{mode:0o700});
 const env={...process.env,OPENREVIEW_BRIDGE_HOME:home,PATH:bin};
 const run=()=>execute(process.execPath,[path.resolve('bin/openreview.mjs'),'bridge','status'],{env,timeout:15000});
 const failed=async()=>{try{await run();assert.fail('An unavailable bridge must retain a failing exit status');}catch(error){const e=error as Error&{stdout:string;stderr:string};assert.match(e.stdout,/codex: available/);assert.match(e.stdout,/claude: unavailable/);assert.match(e.stdout,/cursor: unavailable/);return e;}};
 const missing=await failed();assert.match(missing.stderr,/not paired/);assert.match(missing.stderr,/bridge pair/);
 let requests=0,healthy=false;const server=createServer((req,res)=>{requests++;assert.equal(req.url,'/api/bridge/status');res.writeHead(healthy?200:400);res.end(healthy?JSON.stringify({status:'paired',workspace:'Fixture'}):'{}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const secret='obr_'+'a'.repeat(64);
  const original=JSON.stringify({url:`http://127.0.0.1:${address.port}`,token:secret,repositories:{'github.com/alice/repo':'/fixture/repo'}});
  await writeFile(path.join(home,'config.json'),original);
  const rejected=await failed();assert.match(rejected.stdout,/1 registered Git checkouts/);assert.match(rejected.stderr,/400/);assert.ok(!rejected.stdout.includes(secret)&&!rejected.stderr.includes(secret));
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(path.join(home,'config.json'),'utf8'),original);assert.equal(requests,1);
  await writeFile(path.join(home,'config.json'),JSON.stringify({token:'private-corrupt-value'}));
  const malformed=await failed();assert.match(malformed.stderr,/configuration.*read/i);assert.ok(!malformed.stdout.includes('private-corrupt-value')&&!malformed.stderr.includes('private-corrupt-value'));assert.equal(requests,1);
  await writeFile(path.join(home,'config.json'),original);healthy=true;
  const connected=await run();assert.match(connected.stdout,/"status": "paired"/);assert.match(connected.stdout,/codex: available/);assert.equal(requests,2);
  await writeFile(path.join(home,'config.json'),JSON.stringify({...JSON.parse(original),url:'http://127.0.0.1:1'}));
  const offline=await failed();assert.match(offline.stderr,/status unavailable/);assert.equal(requests,2);assert.ok(!offline.stderr.includes(secret));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});


test('native dispatch rejects unpaired or corrupt setup with safe recovery before claiming a request',async()=>{
 const execute=promisify(execFile),home=await mkdtemp(path.join(tmpdir(),'openreview-dispatch-setup-'));
 const run=()=>execute(process.execPath,[path.resolve('bin/openreview.mjs'),'bridge','dispatch','--desktop','openreview://fix?request=abcdefghijklmnop'],{env:{...process.env,OPENREVIEW_BRIDGE_HOME:home},timeout:15000});
 const failure=async()=>{try{await run();assert.fail('Dispatch must not launch without valid pairing');}catch(error){const e=error as Error&{stdout:string;stderr:string};assert.ok(!e.stdout.includes('Launching'));assert.ok(!e.stdout.includes('Press Enter'));return e;}};
 try{
  const missing=await failure();assert.match(missing.stderr,/not paired/);assert.match(missing.stderr,/bridge pair/);assert.ok(!missing.stderr.includes(home));
  const {readFile,readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(home),[]);
  const original='{"token":"private-corrupt-value", invalid json';await writeFile(path.join(home,'config.json'),original);
  const corrupt=await failure();assert.match(corrupt.stderr,/configuration.*read/i);assert.ok(!corrupt.stderr.includes('private-corrupt-value'));assert.equal(await readFile(path.join(home,'config.json'),'utf8'),original);assert.deepEqual(await readdir(home),['config.json']);
 }finally{await rm(home,{recursive:true,force:true});}
});
