import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { validateRuntimeArchive } from "./sandbox";
import { runtimeRevisionSchema } from "../src/runtime-revision";

export class RuntimeWorkerConfigurationError extends Error {}
export class RuntimeWorkerCredentialError extends Error {}
export function runtimeWorkerExitCode(error:unknown){return error instanceof RuntimeWorkerConfigurationError||error instanceof RuntimeWorkerCredentialError?78:1;}
const jobSchema=z.object({id:z.string(),headSha:runtimeRevisionSchema,repository:z.string(),image:z.string(),command:z.string(),timeout:z.number().int().min(1).max(600),
 // Generated reproduction tests: each runs separately on a fresh copy of the same snapshot.
 kind:z.literal("tests").optional(),tests:z.array(z.object({fingerprint:z.string().max(100),path:z.string().max(200),content:z.string().max(20000),command:z.string().max(2600)})).max(3).optional()});
// Reads the source snapshot once (bounded) so each generated test starts from an untouched copy.
async function snapshotBuffer(body:ReadableStream<Uint8Array>,limit=20_000_000){
 const chunks:Uint8Array[]=[];let size=0;
 for await(const chunk of Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])){size+=chunk.length;if(size>limit)throw new Error("Runtime snapshot exceeds 20 MB");chunks.push(chunk);}
 return Buffer.concat(chunks);
}
export async function runtimeWorker(url:string,credential:string,once=false){
 let origin:URL;try{origin=new URL(url);}catch{throw new RuntimeWorkerConfigurationError("Use your HTTPS Convex HTTP origin (or localhost for development)");}
 if(origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash||(origin.protocol!=="https:"&&!(origin.protocol==="http:"&&["localhost","127.0.0.1"].includes(origin.hostname))))throw new RuntimeWorkerConfigurationError("Use your HTTPS Convex HTTP origin (or localhost for development)");
 if(!/^orw_[a-f0-9]{64}$/.test(credential))throw new RuntimeWorkerConfigurationError("Set OPENREVIEW_WORKER_TOKEN to the approved worker credential");
 const request=async(action:string,body:unknown,signal?:AbortSignal)=>{
  const response=await fetch(new URL("/runtime/"+action,origin),{method:"POST",redirect:"error",headers:{authorization:"Bearer "+credential,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(120000),...(signal?[signal]:[])])});
  if(!response.ok){
   if(response.status===401){const body=await response.json().catch(()=>null);if(body?.code==="worker_credential_rejected")throw new RuntimeWorkerCredentialError("Runtime worker credential expired or revoked; replace it before restarting");}
   throw new Error("Runtime "+action+" rejected or unavailable ("+response.status+")");
  }return response;
 };
 do{
  const lease=randomUUID(),claimed=await(await request("claim",{lease})).json();
  if(claimed){
   const job=jobSchema.parse(claimed);console.log("Running approved runtime job",job.id,"at",job.headSha);
   const heartbeatStop=new AbortController(),executionStop=new AbortController();
   let credentialError:RuntimeWorkerCredentialError|undefined;
   const heartbeat=(async()=>{
    while(!heartbeatStop.signal.aborted){
     try{
      await delay(30000,undefined,{signal:heartbeatStop.signal});
      await request("heartbeat",{id:job.id,lease},heartbeatStop.signal);
     }catch(e){
      if(heartbeatStop.signal.aborted)break;
      if(e instanceof RuntimeWorkerCredentialError){credentialError=e;executionStop.abort(e);break;}
      console.error(e instanceof Error?e.message:"Runtime heartbeat failed");
     }
    }
   })();
   let evidence,error,tests:{fingerprint:string;evidence?:Awaited<ReturnType<typeof validateRuntimeArchive>>;error?:string}[]|undefined;
   try{
    try{
     const response=await request("snapshot",{id:job.id,lease},executionStop.signal);
     if(!response.body)throw new Error("Missing runtime snapshot");
     if(job.kind==="tests"){
      const snapshot=await snapshotBuffer(response.body);tests=[];
      for(const test of job.tests??[]){
       try{const result=await validateRuntimeArchive(job.image,test.command,job.timeout,job.headSha,Readable.from(snapshot),1,executionStop.signal,{path:test.path,content:test.content});tests.push({fingerprint:test.fingerprint,evidence:{...result,output:result.output.slice(-8000)}});}
       catch(e){if(executionStop.signal.aborted)throw e;tests.push({fingerprint:test.fingerprint,error:e instanceof Error?e.message.slice(0,1000):"Generated test failed to run"});}
      }
     }else evidence=await validateRuntimeArchive(job.image,job.command,job.timeout,job.headSha,Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),1,executionStop.signal);
    }catch(e){
     if(e instanceof RuntimeWorkerCredentialError){credentialError=e;executionStop.abort(e);}
     error=e instanceof Error?e.message.slice(0,1000):"Runtime execution failed";
    }
    if(credentialError)throw credentialError;
    for(let attempt=0;;attempt++){
     try{await request("report",{id:job.id,lease,evidence,error,...(tests?{tests}:{})},executionStop.signal);break;}
     catch(e){if(credentialError)throw credentialError;if(e instanceof RuntimeWorkerCredentialError||attempt===2)throw e;await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));}
    }
   }finally{heartbeatStop.abort();await heartbeat;if(credentialError)throw credentialError;}
   console.log("Recorded runtime result",job.id,evidence?.exitCode??"unavailable");
  }
  if(!once)await new Promise(resolve=>setTimeout(resolve,5000));
 }while(!once);
}
if(process.argv[1]?.endsWith("runtime-worker.ts")){
 const {values}=parseArgs({options:{url:{type:"string"},once:{type:"boolean",default:false}}});
 runtimeWorker(values.url??process.env.OPENREVIEW_WORKER_URL??"",process.env.OPENREVIEW_WORKER_TOKEN??"",values.once).catch(e=>{console.error(e instanceof Error?e.message:"Worker failed");process.exitCode=runtimeWorkerExitCode(e);});
}
