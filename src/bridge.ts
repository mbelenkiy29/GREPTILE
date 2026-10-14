import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { readFile, writeFile, mkdir, realpath, chmod, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { installProtocol } from "./bridge-install";
import {p4CheckoutSchema,p4CheckoutKey,registerP4Checkout,verifyP4Checkout,p4FixFileSchema,p4CheckoutEnvironment} from "./bridge-p4";
const execute=promisify(execFile);
const directory=process.env.OPENREVIEW_BRIDGE_HOME??path.join(homedir(),".config","openreview","bridge");
const configSchema=z.object({url:z.string().url(),token:z.string().regex(/^obr_[a-f0-9]{64}$/),repositories:z.record(z.string()).default({}),p4Repositories:z.record(p4CheckoutSchema).default({})});
type Config=z.infer<typeof configSchema>;
export function bridgeUrl(raw:string) {
 const u=new URL(raw);if(u.protocol!=="https:"&&!(u.protocol==="http:"&&["localhost","127.0.0.1"].includes(u.hostname)))throw new Error("Bridge server requires HTTPS or local development HTTP");
 if(u.username||u.password||u.search||u.hash||u.pathname!=="/")throw new Error("Use the server origin without credentials, path, query, or fragment");return u.origin;
}
export function requestId(raw:string) {
 const u=new URL(raw);const id=u.searchParams.get("request");if(u.protocol!=="openreview:"||u.hostname!=="fix"||u.pathname||u.hash||u.username||u.password||u.searchParams.size!==1||!id||!/^[a-z0-9]{16,64}$/.test(id))throw new Error("Invalid OpenReview fix link");return id;
}
export function remoteIdentity(raw:string) {
 const cleaned=raw.trim().replace(/^git@([^:]+):/,"https://$1/");const u=new URL(cleaned);if(!["https:","http:","ssh:"].includes(u.protocol))throw new Error("Unsupported repository remote");
 return u.host.toLowerCase()+u.pathname.replace(/\.git$/i,"").replace(/\/$/,"");
}
type CursorExecutable="cursor-agent"|"cursor";
export async function resolveCodexAgent(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):Promise<{file:string;prefix:string[]}> {
 if(platform!=="win32")return {file:"codex",prefix:[]};
 try{await execute("codex",["--help"],{env,timeout:10000});return {file:"codex",prefix:[]};}catch{
  // Windows npm command shims require cmd.exe. Use the fixed package entry
  // point with this Node runtime instead; prompts never become shell text.
  if(platform==="win32")for(const entry of (env.Path??env.PATH??"").split(";")){
   const directory=entry.trim().replace(/^"(.*)"$/,"$1");if(!directory)continue;
   const installed=path.join(directory,"node_modules","@openai","codex"),script=path.join(installed,"bin","codex.js");
   try{
    if(!(await stat(path.join(directory,"codex.cmd"))).isFile()||!(await stat(script)).isFile())continue;
    if(JSON.parse(await readFile(path.join(installed,"package.json"),"utf8")).name!=="@openai/codex")continue;
    const canonical=await realpath(script);
    await execute(process.execPath,[canonical,"--help"],{env,timeout:10000});
    return {file:process.execPath,prefix:[canonical]};
   }catch{ /* Try only the next fixed npm package location. */ }
  }
 }
 throw new Error("Codex is not available. Install the official Codex CLI and ensure its executable or npm command directory is on the terminal PATH.");
}
export async function resolveCursorAgent(env:NodeJS.ProcessEnv=process.env):Promise<CursorExecutable> {
 for(const file of ["cursor-agent","cursor"] as const){
  try{await execute(file,file==="cursor"?["agent","--help"]:["--help"],{env,timeout:10000});return file;}catch{ /* Try only the next fixed adapter. */ }
 }
 throw new Error("Cursor Agent is not available. Install the official Cursor CLI and ensure cursor-agent or cursor agent is on the terminal PATH.");
}
export function agentCommand(agent:string,prompt:string,root:string,cursorExecutable:CursorExecutable="cursor") {
 if(agent==="codex")return {file:"codex",args:["-C",root,prompt]};
 if(agent==="claude")return {file:"claude",args:[prompt]};
 if(agent==="cursor")return {file:cursorExecutable,args:cursorExecutable==="cursor"?["agent",prompt]:[prompt]};
 throw new Error("Unsupported coding agent");
}
async function save(c:Config){await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path.join(directory,"config.json"),JSON.stringify(c,null,2),{mode:0o600});await chmod(path.join(directory,"config.json"),0o600);}
async function load():Promise<Config>{
 try{return configSchema.parse(JSON.parse(await readFile(path.join(directory,"config.json"),"utf8")));}catch(error){
  if((error as NodeJS.ErrnoException).code==="ENOENT")throw new Error("Bridge is not paired. Run openreview bridge pair --url <OpenReview server origin>, then approve pairing in Personal settings.");
  throw new Error("Bridge configuration could not be read. Inspect the local config.json or pair again; existing configuration was preserved.");
 }
}
async function call(c:Config,action:string,body:unknown){const r=await fetch(`${bridgeUrl(c.url)}/api/bridge/${action}`,{method:"POST",redirect:"error",headers:{authorization:`Bearer ${c.token}`,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Bridge ${action} rejected (${r.status}); pair again or create a new fix request`);return await r.json();}
export async function bridgeMain(args:string[]) {
 const {positionals,values}=parseArgs({args,allowPositionals:true,options:{url:{type:"string"},name:{type:"string"},instance:{type:"string"},project:{type:"string"},server:{type:"string"},client:{type:"string"},user:{type:"string"},p4:{type:"string"},tickets:{type:"string"},trust:{type:"string"},help:{type:"boolean"},desktop:{type:"boolean"}}});
 const command=positionals[0];
 if(!command||values.help){console.log("openreview bridge pair --url https://review.example.com\nopenreview bridge install\nopenreview bridge register /path/to/repository\nopenreview bridge register-p4 /path/to/client --server ssl:host:1666 --client CLIENT --instance https://review.example.com --project PROJECT [--user USER --p4 /path/p4 --tickets /path/tickets --trust /path/trust]\nopenreview bridge status\nopenreview bridge dispatch 'openreview://fix?request=…'");return;}
 if(command==="pair"){
  const c:Config={url:bridgeUrl(values.url??""),token:"obr_"+randomBytes(32).toString("hex"),repositories:{},p4Repositories:{}};const code=randomBytes(6).toString("hex");
  await call(c,"pair",{code,name:values.name??hostname()});await save(c);
  console.log(`Open ${c.url}/dashboard/settings/agents and approve pairing code ${code}. Then run openreview bridge status. Credentials expire after 90 days and can be revoked there.`);return;
 }
 if(command==="install"){await installProtocol(directory,fileURLToPath(new URL("../bin/openreview.mjs",import.meta.url)),process.execPath);console.log("OpenReview protocol installed. Pair the bridge and register your repository before clicking Fix.");return;}
 if(command==="status") {
  // Local setup diagnostics must work even before pairing or during an outage.
  for(const agent of ["codex","claude","cursor"]){try {if(agent==="cursor")await resolveCursorAgent();else if(agent==="codex"){const resolved=await resolveCodexAgent();await execute(resolved.file,[...resolved.prefix,"--help"],{timeout:10000});}else await execute(agent,["--help"],{timeout:10000});console.log(`${agent}: available`);}catch{console.log(`${agent}: unavailable`);}}
  const configured=await load();
  console.log(`${Object.keys(configured.repositories).length} registered Git checkouts; ${Object.keys(configured.p4Repositories).length} registered P4 checkouts`);
  try{console.log(JSON.stringify(await call(configured,"status",{}),null,2));}catch(error){
   const rejection=error instanceof Error?error.message.match(/^Bridge status rejected \((\d+)\)/)?.[1]:undefined;
   throw new Error(`Bridge status unavailable${rejection?` (${rejection})`:""}. Check the server and pairing status; pair again if the credential was revoked or expired. Existing configuration was preserved.`);
  }
  return;
 }
 const c=await load();
 if(command==="register-p4"){
  const key=p4CheckoutKey(values.instance??"",values.project??""),checkout=await registerP4Checkout({root:positionals[1]??process.cwd(),server:values.server??"",client:values.client??"",username:values.user,p4Executable:values.p4,ticketsFile:values.tickets,trustFile:values.trust});
  c.p4Repositories[key]=checkout;await save(c);console.log(`Registered ${key} at ${checkout.root}. P4 Fix dispatch requires a supported server request; registration does not launch an agent.`);return;
 }
 if(command==="register"){const root=await realpath(positionals[1]??process.cwd());const remote=(await execute("git",["-C",root,"remote","get-url","origin"])).stdout;c.repositories[remoteIdentity(remote)]=root;await save(c);console.log(`Registered ${remoteIdentity(remote)} at ${root}`);return;}
 if(command!=="dispatch")throw new Error("Unknown bridge command");
 const id=requestId(positionals[1]??"");
 const payload=await call(c,"claim",{requestId:id});
 let agentFinishedSuccessfully=false;
 try {
 const task=z.object({requestId:z.string(),repository:z.string(),remoteUrl:z.string().optional(),headSha:z.string().regex(/^(?:[a-f0-9]{40}|p4:[1-9]\d*:[1-9]\d*:[1-9]\d*:[a-f0-9]{64})$/),native:z.object({instance:z.string(),project:z.string(),serverId:z.string(),files:z.array(p4FixFileSchema).min(1).max(1000)}).optional(),agent:z.enum(["codex","claude","cursor"]),prompt:z.string().min(20).max(100000)}).parse(payload);
  let root:string,dirty:string,environment:NodeJS.ProcessEnv|undefined,nativeInstructions="";
  if(task.native){
   const key=p4CheckoutKey(task.native.instance,task.native.project),checkout=c.p4Repositories[key];if(!checkout)throw new Error(`Register the native client for ${key} with openreview bridge register-p4`);
   if(checkout.serverId!==task.native.serverId||!task.headSha.startsWith("p4:"))throw new Error("P4 task server identity mismatch");
   root=await verifyP4Checkout(checkout,task.native.files);environment=p4CheckoutEnvironment(checkout);nativeInstructions="\nNative P4 executable: "+JSON.stringify(checkout.p4Executable??"p4")+". Use this executable with the inherited native client environment for read-only diffs. Do not print credentials or ticket files.";dirty="P4 checkout may contain existing opened files";
  }else{
  if(!/^[a-f0-9]{40}$/.test(task.headSha))throw new Error("Git fix requires a Git revision");
  const identity=remoteIdentity(task.remoteUrl??`https://github.com/${task.repository}`);root=c.repositories[identity];if(!root)throw new Error(`Register the local checkout for ${identity} with openreview bridge register`);
  const actual=remoteIdentity((await execute("git",["-C",root,"remote","get-url","origin"])).stdout);if(actual!==identity)throw new Error("Registered repository remote changed");
  const head=(await execute("git",["-C",root,"rev-parse","HEAD"])).stdout.trim();if(head!==task.headSha)throw new Error(`Checkout is at ${head.slice(0,8)}; this finding belongs to ${task.headSha.slice(0,8)}. Select the correct branch/worktree, register it, and create a new request. No files were changed.`);
  dirty=(await execute("git",["-C",root,"status","--porcelain"])).stdout;
  }
  const prompt=task.prompt+nativeInstructions+(dirty?"\nThis checkout contains existing uncommitted changes. Inspect and preserve them; do not reset, discard, or overwrite unrelated work.":"");
  const promptFile=path.join(directory,"fix-"+id+".txt");
  await writeFile(promptFile,prompt,{mode:0o600,flag:"wx"});
  const cursorExecutable=task.agent==="cursor"?await resolveCursorAgent():undefined;
  const codexExecutable=task.agent==="codex"?await resolveCodexAgent():undefined;
  const {file,args}=agentCommand(task.agent,"Read the fix request at "+JSON.stringify(promptFile)+" and follow its instructions. Preserve existing changes and leave an inspectable diff.",root,cursorExecutable);
  console.log(`Launching ${task.agent} in ${root}. Launching does not resolve findings. Review the diff before committing.`);
  const child=spawn(codexExecutable?.file??file,[...(codexExecutable?.prefix??[]),...args],{cwd:root,env:environment,stdio:"inherit",shell:false});
  const completed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once("close",(code,signal)=>resolve({code,signal})));
  await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});
  let launchReported=true;
  try{await call(c,"report",{requestId:id,status:"launched"});}catch{
   launchReported=false;
   console.error("The agent started, but its launch status could not be confirmed by the server. Keep this terminal open; do not create another Fix request while it is running.");
  }
  const {code,signal}=await completed;
  if(code!==0)throw new Error(`${task.agent} exited ${signal?`after signal ${signal}`:`with code ${code}`}. Inspect the checkout and agent output before retrying; findings remain unresolved.`);
  agentFinishedSuccessfully=true;
  try{
   if(!launchReported)await call(c,"report",{requestId:id,status:"launched"});
   await call(c,"report",{requestId:id,status:"finished"});
  }catch{throw new Error(`${task.agent} exited successfully, but its server status could not be confirmed. Review the local diff and test output; do not infer resolution from the portal status.`);}
 }catch(error){const message=error instanceof Error?error.message:"Agent launch failed";if(!agentFinishedSuccessfully)await call(c,"report",{requestId:id,status:"failed",error:message.slice(0,1000)}).catch(()=>{});throw error;}
}
