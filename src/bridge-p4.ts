import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {realpath,readFile,stat,lstat} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {z} from "zod";
import {parseP4CliRows} from "./perforce-depot";
const execute=promisify(execFile);
const localFile=z.string().refine(value=>path.isAbsolute(value)&&!/[\0\r\n]/.test(value),"Use an absolute local file path");
const identifier=z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
export const p4CheckoutSchema=z.object({root:z.string().min(1),server:z.string().regex(/^ssl:(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[1-9]\d{0,4}$/).refine(s=>Number(s.split(":").at(-1))<=65535),serverId:identifier,client:identifier,username:identifier,p4Executable:localFile.optional(),ticketsFile:localFile.optional(),trustFile:localFile.optional()});
export type P4Checkout=z.infer<typeof p4CheckoutSchema>;
export const p4FixFileSchema=z.object({depotFile:z.string().regex(/^\/\/[^\0\r\n#@\\"*]+$/).refine(s=>s.slice(2).split('/').every(p=>!!p&&p!=='.'&&p!=='..'&&p!=='...')),haveRevision:z.number().int().nonnegative().safe(),revision:z.string().regex(/^(?:#[1-9]\d*|@=[1-9]\d*)$/),digest:z.string().regex(/^[a-fA-F0-9]{32}$/),fileSize:z.number().int().nonnegative().max(1000000),nativeAction:z.enum(["add","branch","move/add","edit","integrate","delete","move/delete"]).optional(),archiveChange:z.number().int().positive().safe().optional()}).superRefine((f,ctx)=>{
 const added=f.nativeAction&&["add","branch","move/add"].includes(f.nativeAction),deleted=f.nativeAction&&["delete","move/delete"].includes(f.nativeAction);
 if(f.haveRevision===0&&!added||added&&f.haveRevision!==0||f.nativeAction&&(!f.archiveChange||f.revision!==(deleted?"#"+f.haveRevision:"@="+f.archiveChange)))ctx.addIssue({code:z.ZodIssueCode.custom,message:"P4 native action and pinned revisions disagree"});
});
export type P4FixFile=z.infer<typeof p4FixFileSchema>;
export type P4Read=(args:string[],options:{cwd:string;maxBuffer:number;executable?:string;env?:NodeJS.ProcessEnv})=>Promise<Buffer>;
const nativeRead:P4Read=async(args,options)=>{
 const {executable,...execution}=options;
 try{return (await execute(executable??"p4",args,{...execution,encoding:"buffer",timeout:30000})).stdout;}
 catch{throw new Error("P4 checkout read failed; check the CLI, existing ticket, SSL trust and client mapping. No files were changed.");}
};
type LocalCheckout=Pick<P4Checkout,"root"|"server"|"client">&Partial<Pick<P4Checkout,"username"|"p4Executable"|"ticketsFile"|"trustFile">>;
export function p4CheckoutEnvironment(checkout:LocalCheckout){
 const env:NodeJS.ProcessEnv={...process.env,P4CONFIG:"",P4PORT:checkout.server,P4CLIENT:checkout.client,...(checkout.username?{P4USER:checkout.username}:{}),...(checkout.ticketsFile?{P4TICKETS:checkout.ticketsFile}:{}),...(checkout.trustFile?{P4TRUST:checkout.trustFile}:{})};
 if(checkout.ticketsFile)delete env.P4PASSWD;
 return env;
}
function reader(checkout:LocalCheckout,read:P4Read){
 const prefix=["-p",checkout.server,"-c",checkout.client,...(checkout.username?["-u",checkout.username]:[])];
 const options={cwd:checkout.root,executable:checkout.p4Executable,env:p4CheckoutEnvironment(checkout)};
 return {bytes:(args:string[],limit=8*1024*1024)=>read([...prefix,...args],{...options,maxBuffer:limit}),rows:async(args:string[])=>parseP4CliRows(new TextDecoder("utf-8",{fatal:true}).decode(await read([...prefix,"-Mj","-ztag",...args],{...options,maxBuffer:8*1024*1024})))};
}
async function identity(checkout:Pick<P4Checkout,"root"|"server"|"client">&Partial<Pick<P4Checkout,"username"|"p4Executable"|"ticketsFile"|"trustFile">>,read:P4Read){
 const r=reader(checkout,read),info=await r.rows(["info","-s"]),clients=await r.rows(["client","-o",checkout.client]);
 if(info.length!==1||clients.length!==1)throw new Error("P4 server/client identity unavailable");
 const c=clients[0],i=info[0];
 if(c.Client!==checkout.client||i.clientName!==checkout.client||typeof c.Root!=="string"||typeof i.ServerID!=="string"||typeof i.userName!=="string"||c.Owner!==i.userName||await realpath(c.Root)!==checkout.root)throw new Error("P4 client root, owner or identity mismatch; register the correct native checkout");
 // Digest checks use server bytes. Reject translated workspaces rather than silently normalizing source.
 if(c.LineEnd!=="unix"||typeof c.Options!=="string"||!c.Options.split(/\s+/).includes("noallwrite"))throw new Error("P4 Fix requires a unix-line-ending client with noallwrite for pinned source verification");
 return p4CheckoutSchema.parse({...checkout,serverId:i.ServerID,username:i.userName});
}
export function p4CheckoutKey(instance:string,project:string){
 const u=new URL(instance);if(u.protocol!=="https:"||u.username||u.password||u.pathname!=="/"||u.search||u.hash||!identifier.safeParse(project).success)throw new Error("P4 registration requires the Code Review HTTPS origin and project ID");
 return `p4:${u.origin}:${project}`;
}
export async function registerP4Checkout(input:Omit<P4Checkout,"serverId"|"username">&{username?:string},read:P4Read=nativeRead){
 const root=await realpath(input.root),configuration={...input,root};
 p4CheckoutSchema.omit({serverId:true}).extend({username:identifier.optional()}).parse(configuration);
 for(const key of ["p4Executable","ticketsFile","trustFile"] as const)if(configuration[key]){
  const resolved=await realpath(configuration[key]!);if(!(await stat(resolved)).isFile())throw new Error("P4 setup requires regular local CLI, ticket and trust files");configuration[key]=resolved;
 }
 return identity(configuration,read);
}
async function deletedPath(filename:string){
 let directory=path.dirname(filename);const tail=[path.basename(filename)];
 for(;;){
  try{return path.join(await realpath(directory),...tail);}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
   try{await lstat(directory);throw new Error("P4 deleted path has a dangling symlink");}catch(missing){if((missing as NodeJS.ErrnoException).code!=="ENOENT")throw missing;}
   const parent=path.dirname(directory);if(parent===directory)throw error;tail.unshift(path.basename(directory));directory=parent;
  }
 }
}
export async function verifyP4Checkout(input:P4Checkout,manifest:P4FixFile[],read:P4Read=nativeRead){
 const checkout=p4CheckoutSchema.parse(input),files=z.array(p4FixFileSchema).min(1).max(1000).parse(manifest);
 if(new Set(files.map(f=>f.depotFile)).size!==files.length||files.reduce((sum,f)=>sum+f.fileSize,0)>20000000)throw new Error("P4 fix manifest is duplicated or exceeds verification coverage");
 if(await realpath(checkout.root)!==checkout.root)throw new Error("P4 checkout root changed");
 const current=await identity(checkout,read);if(current.serverId!==checkout.serverId||current.username!==checkout.username)throw new Error("P4 server or user identity changed");
 const r=reader(checkout,read),archives=new Map<number,Record<string,unknown>>();
 for(const f of files){
  if(f.nativeAction){
   if(!archives.has(f.archiveChange!)){const rows=await r.rows(["describe","-S","-s",String(f.archiveChange)]);if(rows.length!==1||String(rows[0].change)!==String(f.archiveChange))throw new Error("P4 archived changelist identity mismatch");archives.set(f.archiveChange!,rows[0]);}
   const archived=archives.get(f.archiveChange!)!,entries=Object.entries(archived).filter(([key])=>/^depotFile\d+$/.test(key)),matches=entries.filter(([,value])=>value===f.depotFile);
   if(matches.length!==1||archived["action"+matches[0][0].slice(9)]!==f.nativeAction)throw new Error("P4 archived file action differs from the reviewed shelf");
  }
  const rows=await r.rows(["fstat","-T","depotFile,clientFile,haveRev,action,movedFile,movedRev",f.depotFile]);
  if(rows.length!==1||rows[0].depotFile!==f.depotFile||f.nativeAction!=='move/add'&&String(rows[0].haveRev??0)!==String(f.haveRevision)||typeof rows[0].clientFile!=="string"||f.nativeAction&&rows[0].action!==f.nativeAction)throw new Error("P4 checkout have revision or depot mapping differs; select the reviewed checkout without overwriting existing work");
  if(f.nativeAction==='move/add'){
   const from=files.find(source=>source.depotFile===rows[0].movedFile&&source.nativeAction==='move/delete'&&source.archiveChange===f.archiveChange);
   // The target has no submitted baseline. Native haveRev comes from the
   // moved source, whose reviewed baseline and local mapping are also verified.
   if(!from||String(rows[0].haveRev)!==String(from.haveRevision)||String(rows[0].movedRev)!==String(from.haveRevision))throw new Error('P4 moved source is outside the reviewed baseline or has a different revision');
  }
  const deleted=f.nativeAction==="delete"||f.nativeAction==="move/delete";
  const local=deleted?await deletedPath(rows[0].clientFile):await realpath(rows[0].clientFile),relative=path.relative(checkout.root,local);
  if(!relative||relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))throw new Error("P4 depot file maps outside the registered checkout");
  const pinned=await r.bytes(["print","-q","-K",f.depotFile+f.revision],f.fileSize+4096);
  if(pinned.length!==f.fileSize||createHash("md5").update(pinned).digest("hex")!==f.digest.toLowerCase())throw new Error("P4 pinned file identity changed or is unavailable");
  if(deleted){
   let absent=false;try{await lstat(local);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")absent=true;else throw error;}
   if(!absent)throw new Error("P4 deleted target still exists locally; preserve the changes and select the correct checkout");continue;
  }
  const localStat=await stat(local);if(!localStat.isFile()||localStat.size!==f.fileSize)throw new Error("P4 checkout differs from the reviewed files; preserve the changes and select the correct checkout");
  const actual=await readFile(local);
  if(actual.length!==f.fileSize||createHash("md5").update(actual).digest("hex")!==f.digest.toLowerCase())throw new Error("P4 checkout differs from the reviewed files; preserve the changes and select the correct checkout");
 }
 // Repeat authority after file reads; every native operation above is read-only.
 const final=await identity(checkout,read);if(final.serverId!==checkout.serverId||final.username!==checkout.username)throw new Error("P4 identity changed during verification");
 return checkout.root;
}
