import {z} from "zod";
import {api} from "../../../../convex/_generated/api";
import type {Id} from "../../../../convex/_generated/dataModel";
import { apiIdentity, apiDenied } from "../../../../src/api-auth";
import {backend} from "../../../../src/server";
export async function GET(request:Request){
 try{
  const {token,organizationId}=await apiIdentity(request);
  const repositoryId=z.string().regex(/^[a-z0-9]{20,64}$/).parse(new URL(request.url).searchParams.get("repositoryId"));
  return Response.json(await backend().query(api.p4Index.status,{token,organizationId,repositoryId:repositoryId as Id<"repositories">}),{headers:{"cache-control":"no-store"}});
 }catch (error) { const denied = apiDenied(error); if (denied) return denied;return Response.json({error:"P4 indexing status unavailable; check current administrator access and connection"},{status:403,headers:{"cache-control":"no-store"}});}
}
export async function POST(request:Request){
 try{
  const {token,organizationId}=await apiIdentity(request,"admin");
  const reader=request.body?.getReader();if(!reader)throw new Error("Missing body");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>850000)return Response.json({error:"P4 metadata exceeds hosted upload limit"},{status:413});chunks.push(value);}}finally{await reader.cancel();}
  const input=z.object({repositoryId:z.string().regex(/^[a-z0-9]{20,64}$/),instance:z.string().url().max(4096),inventory:z.unknown()}).strict().parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
  const result=await backend().action(api.p4IndexJobs.upload,{token,organizationId,repositoryId:input.repositoryId as Id<"repositories">,instance:input.instance,inventory:JSON.stringify(input.inventory)});
  return Response.json(result,{status:202});
 }catch (error) { const denied = apiDenied(error); if (denied) return denied;return Response.json({error:"P4 indexing request rejected; check admin access, connected project, current native views and upload limits"},{status:400});}
}
