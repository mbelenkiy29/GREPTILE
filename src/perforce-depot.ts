import {execFile} from "node:child_process";
import {promisify,parseArgs} from "node:util";
import {createHash} from "node:crypto";
import {mkdtemp,rm,writeFile,readFile,stat} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import path from "node:path";
import {z} from "zod";
import {P4CodeReview,p4Credential,p4DepotRecord,p4ProjectSchema,p4PathAllowed,type P4Project} from "./perforce";
import {p4SubmittedInventory,parseP4SubmittedInventory} from "./p4-index";
import {p4ShelfFromIndex} from "./p4-shelf";
import {exclusionReason,indexRepository} from "./engine/indexer";
import {reviewChange} from "./engine/review";
import {modelFromEnvironment} from "./engine/model";
import type {SourceFile} from "./engine/types";
const execute=promisify(execFile);
const record=p4DepotRecord;
const configuration=z.object({server:z.string().regex(/^ssl:(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[1-9]\d{0,4}$/).refine(s=>Number(s.split(":").at(-1))<=65535),serverId:z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),username:p4Credential.shape.username,ticket:p4Credential.shape.ticket,change:z.number().int().positive().safe()});
const connectionConfiguration=configuration.omit({change:true});
const hostedConfiguration=z.object({url:z.string().url(),apiKey:z.string().regex(/^or_[a-zA-Z0-9_-]{16,196}$/)});
function hostedOrigin(input:unknown){
 const config=hostedConfiguration.parse(input),origin=new URL(config.url);
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=="/"||origin.protocol!=="https:"&&!(origin.protocol==="http:"&&["localhost","127.0.0.1"].includes(origin.hostname)))throw new Error("OpenReview login requires a trusted HTTPS origin or local development origin");
 return {config,origin};
}

/** Discover a submitted revision using native CLI metadata, never a default branch or shelf. */
export async function latestP4SubmittedChange(input:P4Project,options:z.infer<typeof connectionConfiguration>){
 const project=p4ProjectSchema.parse(input),config=connectionConfiguration.parse(options);
 // Reuse canonical project/view validation before passing any native file specification.
 p4SubmittedInventory({project,serverId:config.serverId,change:1,manifest:[]});
 const patterns=[...new Set(project.branches.flatMap(b=>b.paths).filter(p=>!p.startsWith("-")).map(p=>p.replace(/^\+/,"")))];
 const directory=await mkdtemp(path.join(tmpdir(),"openreview-p4-latest-"));
 const env:NodeJS.ProcessEnv={NODE_ENV:"production",PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,HOME:process.env.HOME,LANG:"C.UTF-8",P4CONFIG:"",P4ENVIRO:path.join(directory,"environment"),P4TICKETS:path.join(directory,"tickets"),P4TRUST:process.env.P4TRUST,P4PASSWD:config.ticket};
 async function rows(args:string[]){
  let stdout:Buffer;
  try{({stdout}=await execute("p4",["-p",config.server,"-u",config.username,"-Mj","-ztag",...args],{cwd:directory,env,encoding:"buffer",maxBuffer:1024*1024,timeout:60000}));}
  catch{throw new Error("P4 submitted discovery failed; check CLI, existing SSL trust, ticket and protections");}
  return parseP4CliRows(new TextDecoder("utf-8",{fatal:true}).decode(stdout));
 }
 async function identity(){const values=await rows(["info","-s"]);if(values.length!==1||values[0].ServerID!==config.serverId||values[0].userName!==config.username)throw new Error("P4 server or user identity mismatch");}
 try{
  await identity();let latest=0;
  for(const pattern of patterns){
   const values=await rows(["changes","-s","submitted","-m","1",pattern]);
   if(values.length>1)throw new Error("P4 latest submitted result exceeds requested coverage");
   for(const value of values){const row=z.object({change:z.coerce.number().int().positive().safe(),status:z.literal("submitted")}).parse(value);latest=Math.max(latest,row.change);}
  }
  await identity();if(!latest)throw new Error("No visible submitted revision in the selected P4 project");return latest;
 }finally{await rm(directory,{recursive:true,force:true});}
}

export async function syncP4Index(input:{repositoryId:string;instance:string;projectId:string;native:z.infer<typeof connectionConfiguration>;hosted:unknown}){
 const repositoryId=z.string().regex(/^[a-z0-9]{20,64}$/).parse(input.repositoryId),{config,origin}=hostedOrigin(input.hosted);
 const statusUrl=new URL("/api/p4/index",origin);statusUrl.searchParams.set("repositoryId",repositoryId);
 const response=await fetch(statusUrl,{redirect:"error",headers:{authorization:"Bearer "+config.apiKey},signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error("P4 watcher access rejected; check current workspace administrator and connection access");
 const status=z.object({repositoryId:z.literal(repositoryId),projectId:z.string().min(1).max(200),instance:z.string().url(),indexStatus:z.string(),revision:z.string().nullable(),error:z.string().nullable()}).parse(await response.json());
 const client=new P4CodeReview(input.instance,input.native.username,input.native.ticket);
 if(status.projectId!==input.projectId||status.instance!==client.base)throw new Error("P4 watcher repository belongs to another project or connection");
 if(["queued","indexing"].includes(status.indexStatus))return {status:"busy" as const,revision:status.revision};
 if(status.indexStatus==="failed")throw new Error("Hosted P4 indexing failed; inspect diagnostics and explicitly retry index/upload before resuming the watcher");
 const project=await client.project(input.projectId),change=await latestP4SubmittedChange(project,input.native);
 const result=await indexP4Depot(project,{...input.native,change},{metadataOnly:true});
 if(JSON.stringify(await client.project(input.projectId))!==JSON.stringify(project))throw new Error("P4 project views changed during automatic inventory; retry");
 if(status.indexStatus==="ready"&&status.revision===result.revision)return {status:"unchanged" as const,revision:result.revision,change};
 const queued=await uploadP4Index({codeReviewInstance:client.base,inventory:result.inventory},repositoryId,input.hosted);
 return {status:"queued" as const,...queued,change};
}

async function p4WatchMain(values:Record<string,string|boolean|undefined>){
 if(!values.repository||!values.url||!values.project)throw new Error("P4 watch requires --repository, --url, --project, --server and --server-id; use openreview p4 --help");
 const interval=z.coerce.number().int().min(60).max(3600).parse(values.interval??300);
 const native=connectionConfiguration.parse({server:values.server,serverId:values["server-id"],username:process.env.P4USER,ticket:process.env.P4PASSWD});
 const hosted=hostedConfiguration.parse(JSON.parse(await readFile(path.join(homedir(),".config","openreview","config.json"),"utf8")));
 const stop=new AbortController(),shutdown=()=>stop.abort();process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
 let failures=0;
 try{while(!stop.signal.aborted){
  try{console.log(JSON.stringify(await syncP4Index({repositoryId:String(values.repository),instance:String(values.url),projectId:String(values.project),native,hosted})));failures=0;}
  catch{failures++;console.error(JSON.stringify({status:"failed",attempt:failures,message:"P4 indexing failed; check native trust/ticket, administrator access, selected views and dashboard indexing diagnostics"}));if(values.once||failures>=3)throw new Error("P4 watcher stopped after indexing failure");}
  if(values.once)break;
  await new Promise<void>(resolve=>{if(stop.signal.aborted){resolve();return;}const done=()=>{clearTimeout(timer);stop.signal.removeEventListener("abort",done);resolve();},timer=setTimeout(done,interval*1000);stop.signal.addEventListener("abort",done,{once:true});});
 }}finally{process.removeListener("SIGINT",shutdown);process.removeListener("SIGTERM",shutdown);}
}

export function parseP4CliRows(data:string){
 if(data.includes("\uFFFD"))throw new Error("P4 metadata contains replacement characters; source identity unavailable");
 // -Mj omits code on native stat records; error/info records carry diagnostic fields.
 const row=z.object({code:z.literal("stat").optional(),severity:z.never().optional(),generic:z.never().optional(),data:z.never().optional()}).passthrough();
 return data.split("\n").filter(v=>v.trim()).map(v=>{const value:Record<string,unknown>&{code:"stat"}={...row.parse(JSON.parse(v)),code:"stat"};return value;});
}

export async function indexP4Depot(input:P4Project,options:z.infer<typeof configuration>,mode:{metadataOnly?:boolean}={}){
 const project=p4ProjectSchema.parse(input),config=configuration.parse(options);
 if(project.deleted||!project.branches.length)throw new Error("Active P4 project branches required");
 const patterns=[...new Set(project.branches.flatMap(b=>b.paths).filter(p=>!p.startsWith("-")).map(p=>p.replace(/^\+/,"")))];
 if(!patterns.length||patterns.length>100||project.branches.some(b=>b.paths.some(p=>!/^[-+]?\/\/[^\0\r\n#@\\"]+$/.test(p)||p.replace(/^[-+]?\/\//,"").split("/").some(v=>!v||v==="."||v===".."))))throw new Error("P4 project views exceed native indexing coverage");
 const directory=await mkdtemp(path.join(tmpdir(),"openreview-p4-"));
 // Isolate local config and cached tickets; only the explicit server/user/ticket may authorize reads.
 const env:NodeJS.ProcessEnv={NODE_ENV:"production",PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,HOME:process.env.HOME,LANG:"C.UTF-8",P4CONFIG:"",P4ENVIRO:path.join(directory,"environment"),P4TICKETS:path.join(directory,"tickets"),P4TRUST:process.env.P4TRUST,P4PASSWD:config.ticket};
 const prefix=["-p",config.server,"-u",config.username];
 async function bytes(args:string[],limit:number){
  try{const {stdout}=await execute("p4",[...prefix,...args],{cwd:directory,env,encoding:"buffer",maxBuffer:limit,timeout:60000});return stdout;}
  catch{throw new Error("P4 read failed or exceeded its limit; check the installed CLI, SSL trust, ticket, protections and server identity");}
 }
 async function rows(args:string[]){
  const data=new TextDecoder("utf-8",{fatal:true}).decode(await bytes(["-Mj","-ztag",...args],8*1024*1024));
  return parseP4CliRows(data);
 }
 async function identity(){const values=await rows(["info","-s"]);if(values.length!==1||values[0].ServerID!==config.serverId||values[0].userName!==config.username)throw new Error("P4 server or user identity mismatch");}
 try{
  await identity();const changes=await rows(["change","-o",String(config.change)]);
  if(changes.length!==1||String(changes[0].Change)!==String(config.change)||changes[0].Status!=="submitted")throw new Error("P4 indexing requires the exact submitted changelist");
  const manifest=new Map<string,z.infer<typeof record>>();
  for(const pattern of patterns){
   const values=await rows(["fstat","-Os","-Ol","-T","depotFile,headRev,headChange,headAction,headType,fileSize,digest","-m","10001",pattern+"@"+config.change]);
   // ponytail: 10,000 native records per project; partition durable inventory beyond this ceiling.
   if(values.length>10000)throw new Error("P4 inventory exceeds 10,000 records; complete coverage unavailable");
   for(const value of values){const f=record.strip().parse(value);if(f.headChange>config.change||!p4PathAllowed(f.depotFile,[pattern]))throw new Error("P4 inventory revision or requested view mismatch");
    if(!project.branches.some(b=>p4PathAllowed(f.depotFile,b.paths)))continue;
    const previous=manifest.get(f.depotFile);if(previous&&JSON.stringify(previous)!==JSON.stringify(f))throw new Error("P4 overlapping views returned inconsistent revisions");manifest.set(f.depotFile,f);
    if(manifest.size>10000)throw new Error("P4 project inventory exceeds coverage limit");
   }
  }
  const files:SourceFile[]=[],skipped:{path:string;reason:string}[]=[];let total=0;
  for(const f of [...manifest.values()].sort((a,b)=>a.depotFile.localeCompare(b.depotFile))){
   const relative=f.depotFile.slice(2),sha=`p4:${config.serverId}:${f.headRev}:${f.digest?.toLowerCase()??"unreadable"}`;
   let reason=["delete","move/delete"].includes(f.headAction)?"Deleted at indexed revision":!["add","edit","branch","move/add","integrate","import"].includes(f.headAction)?"Archived or unavailable source action":!["text","utf8","unicode"].includes(f.headType.split("+")[0])?"Unsupported source type":exclusionReason({path:relative,sha,size:f.fileSize,content:""});
   if(reason){skipped.push({path:f.depotFile,reason});continue;}
   if(f.fileSize===undefined||!f.digest)throw new Error("P4 readable source metadata has no pinned digest or size");
   // Hosted indexing independently reads/digest-checks source and reuses unchanged file caches.
   if(mode.metadataOnly){total+=f.fileSize;if(total>20_000_000)throw new Error("P4 source inventory exceeds 20 MB indexing coverage");continue;}
   const content=await bytes(["print","-q","-K",f.depotFile+"#"+f.headRev],200001);
   if(content.length!==f.fileSize||createHash("md5").update(content).digest("hex")!==f.digest.toLowerCase())throw new Error("P4 source size or digest differs from pinned inventory");
   let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(content);}catch{skipped.push({path:f.depotFile,reason:"Source is not UTF-8"});continue;}
   reason=exclusionReason({path:relative,sha,size:f.fileSize,content:text});if(reason){skipped.push({path:f.depotFile,reason});continue;}
   total+=content.length;if(total>20_000_000)throw new Error("P4 source inventory exceeds 20 MB indexing coverage");files.push({path:relative,sha,size:f.fileSize,content:text});
  }
  await identity();
  const inventory=p4SubmittedInventory({project,serverId:config.serverId,change:config.change,manifest:[...manifest.values()]});
  return {projectId:project.id,serverId:config.serverId,change:config.change,revision:inventory.revision,inventory,revisions:Object.fromEntries([...manifest.values()].filter(f=>!["delete","move/delete"].includes(f.headAction)).map(f=>[f.depotFile,f.headRev])),index:indexRepository(files),skipped,coverage:["P4 protections may hide files; hidden inventory cannot be measured.","Paths are depot-relative. Project-specific ignore files are not applied automatically."]};
 }finally{await rm(directory,{recursive:true,force:true});}
}

// Native CLI and hosted actions share exactly the same archived-shelf ingestion.
export async function p4ShelfInput(client:P4CodeReview,projectId:string,reviewId:number,options:z.infer<typeof configuration>){
 const project=await client.project(projectId),snapshot=await client.snapshot(projectId,reviewId);
 if(!snapshot.review.versions.at(-1)?.pending||!["needsReview","needsRevision"].includes(snapshot.review.state))throw new Error("P4 review must have an open archived shelf");
 const baseline=await indexP4Depot(project,options);
 return p4ShelfFromIndex(client,projectId,reviewId,{inventory:baseline.inventory,files:baseline.index.files,coverage:baseline.coverage});
}

export async function uploadP4Index(artifactInput:unknown,repositoryInput:string,configurationInput:unknown){
  const repositoryId=z.string().regex(/^[a-z0-9]{20,64}$/).parse(repositoryInput);
  const artifact=z.object({codeReviewInstance:z.string().url(),inventory:z.unknown()}).parse(artifactInput);
  const inventory=parseP4SubmittedInventory(artifact.inventory);if(Buffer.byteLength(JSON.stringify(inventory))>750000||inventory.manifest.length>8000)throw new Error("P4 inventory exceeds hosted upload coverage (750 KB / 8,000 records)");
  const {config,origin}=hostedOrigin(configurationInput);
  const response=await fetch(new URL("/api/p4/index",origin),{method:"POST",redirect:"error",headers:{authorization:"Bearer "+config.apiKey,"content-type":"application/json"},body:JSON.stringify({repositoryId,instance:artifact.codeReviewInstance,inventory}),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error("P4 upload rejected ("+response.status+"); check admin access, selected project and current native views");
  const result=z.object({jobId:z.string(),revision:z.string(),total:z.number().int().nonnegative()}).parse(await response.json());
  if(result.revision!==inventory.revision)throw new Error("P4 upload returned another inventory revision");return result;
}

export async function p4IndexMain(args:string[]){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{server:{type:"string"},"server-id":{type:"string"},url:{type:"string"},project:{type:"string"},change:{type:"string"},review:{type:"string"},mode:{type:"string",default:"standard"},output:{type:"string"},input:{type:"string"},repository:{type:"string"},interval:{type:"string"},once:{type:"boolean"},help:{type:"boolean"}}});
 if(positionals.length===1&&positionals[0]==="watch"&&!values.help){await p4WatchMain(values);return;}
 if(positionals.length===1&&positionals[0]==="upload"&&!values.help){
  if(!values.input||!values.repository)throw new Error("Use openreview p4 upload --input <index.json> --repository <OpenReview repository ID>");
  if((await stat(values.input)).size>40000000)throw new Error("P4 index artifact exceeds local read limit");
  const result=await uploadP4Index(JSON.parse(await readFile(values.input,"utf8")),values.repository,JSON.parse(await readFile(path.join(homedir(),".config","openreview","config.json"),"utf8")));
  console.log(JSON.stringify(result));return;
 }
 if(values.help){console.log("openreview p4 index --server ssl:host:1666 --server-id <native-server-id> --url https://code-review.example --project <project-id> --change <submitted-change> --output <new-index.json>\nopenreview p4 watch --server ssl:host:1666 --server-id <native-server-id> --url https://code-review.example --project <project-id> --repository <OpenReview repository ID> [--interval 300] [--once]\nopenreview p4 review [same connection/baseline options] --review <native-review-id> --mode fast|standard|deep --output <new-review.json>\nopenreview p4 upload --input <new-index.json> --repository <OpenReview repository ID>\nWatch discovers submitted revisions and refreshes hosted indexing; run under your process supervisor for continuous operation. It does not enable review polling. Upload/watch require openreview login and workspace admin access. Only metadata is uploaded; the hosted bot independently retrieves pinned sources.\nSet P4USER and P4PASSWD to the read-only bot username and ticket. Configure SCM_ALLOWED_HOSTS for the Code Review host. SSL trust must already be established; this command never accepts an unknown server fingerprint. Review requires configured LLM environment variables; it does not publish comments or alter the shelf.");return;}
 if(positionals.length!==1||!["index","review"].includes(positionals[0])||!values.output||!values.url||!values.project||!values.change||!/^\d+$/.test(values.change)||positionals[0]==="review"&&(!values.review||!/^\d+$/.test(values.review)))throw new Error("Use openreview p4 --help for required options");
 const mode=z.enum(["fast","standard","deep"]).parse(values.mode),config=configuration.parse({server:values.server,serverId:values["server-id"],username:process.env.P4USER,ticket:process.env.P4PASSWD,change:Number(values.change)});
 const reviewId=positionals[0]==="review"?z.number().int().positive().safe().parse(Number(values.review)):undefined;
 try{await stat(values.output);throw new Error("EEXIST: output already exists");}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
 const client=new P4CodeReview(values.url,config.username,config.ticket);
 if(reviewId!==undefined){
  const data=await p4ShelfInput(client,values.project,reviewId,config),result=await reviewChange({...data.input,mode},modelFromEnvironment());
  const latest=await client.snapshot(values.project,reviewId);
  if(!latest.review.versions.at(-1)?.pending||latest.revision!==data.input.headSha||!["needsReview","needsRevision"].includes(latest.review.state))throw new Error("P4 shelf changed during inference; result was not saved");
  await writeFile(values.output,JSON.stringify({projectId:values.project,serverId:data.serverId,reviewId,version:data.version,change:data.change,revision:data.input.headSha,baseRevision:data.input.baseSha,result},null,2),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({output:path.resolve(values.output),revision:data.input.headSha,findings:result.findings.length,reviewScore:result.metadata.reviewScore,estimatedCost:result.usage.reduce((sum,u)=>sum+u.estimatedCost,0)}));return;
 }
 const selected=await client.project(values.project),result=await indexP4Depot(selected,config);
 if(JSON.stringify(await client.project(values.project))!==JSON.stringify(selected))throw new Error("P4 project view changed during indexing; retry before saving");
 await writeFile(values.output,JSON.stringify({...result,codeReviewInstance:client.base},null,2),{mode:0o600,flag:"wx"});
 console.log(JSON.stringify({output:path.resolve(values.output),revision:result.revision,files:result.index.files.length,symbols:result.index.symbols.length,relationships:result.index.relationships.length,skipped:result.skipped.length,coverage:result.coverage}));
}
