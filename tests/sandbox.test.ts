import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxArguments } from "../scripts/sandbox";
test("runtime sandbox is pinned, isolated and bounded without host mounts or secrets", () => {
  const args = sandboxArguments(
    "test",
    "node@sha256:" + "a".repeat(64),
    "npm test",
    120,
  );
  for (const flag of [
    "--read-only",
    "--cap-drop",
    "--security-opt",
    "--pids-limit",
    "--cpus",
    "--memory",
  ])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args.includes("--mount"), false);
  assert.equal(args.includes("-v"), false);
  assert.equal(args.includes("--env"), false);
  assert.ok(sandboxArguments("test","node@sha256:"+"a".repeat(64),"node --test",120,1).some(a=>a.startsWith("tar -xzf - -C /work --strip-components=1")));
  assert.throws(() => sandboxArguments("test", "node:latest", "npm test", 120));
  assert.throws(() =>
    sandboxArguments("test", "node@sha256:" + "a".repeat(64), "npm test", 601),
  );
});

test('aborting runtime execution kills the Docker invocation and removes its exact container',{timeout:10000},async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{Readable}=await import('node:stream'),{validateRuntimeArchive}=await import('../scripts/sandbox');
 const folder=await mkdtemp(join(tmpdir(),'openreview-runtime-abort-')),previousPath=process.env.PATH;
 const receipt=join(folder,'receipt.jsonl');
 await writeFile(join(folder,'docker'),`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='run'){process.stdin.resume();setInterval(()=>{},1000);}else process.exit(0);\n`,{mode:0o700});
 process.env.PATH=folder;
 try{
  const controller=new AbortController(),reason=new Error('Runtime authorization revoked');
  const execution=validateRuntimeArchive('node@sha256:'+'a'.repeat(64),'node --test',120,'a'.repeat(40),Readable.from(['fixture archive']),1,controller.signal);
  const rejected=assert.rejects(execution,error=>error===reason);
  for(let i=0;i<100;i++){
   if(await readFile(receipt,'utf8').catch(()=>''))break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  controller.abort(reason);await rejected;
  const calls=(await readFile(receipt,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
  assert.equal(calls.length,2);assert.equal(calls[0][0],'run');assert.equal(calls[1][0],'rm');assert.equal(calls[1][1],'-f');assert.equal(calls[1][2],calls[0][calls[0].indexOf('--name')+1]);
  const alreadyCancelled=new AbortController();alreadyCancelled.abort(reason);
  await assert.rejects(validateRuntimeArchive('node@sha256:'+'a'.repeat(64),'node --test',120,'a'.repeat(40),Readable.from([]),1,alreadyCancelled.signal),error=>error===reason);
  assert.equal((await readFile(receipt,'utf8')).trim().split('\n').length,2,'Pre-aborted execution never launches Docker');
 }finally{process.env.PATH=previousPath;await rm(folder,{recursive:true,force:true});}
});
