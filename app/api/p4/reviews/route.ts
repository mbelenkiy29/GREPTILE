import {z} from "zod";
import {api} from "../../../../convex/_generated/api";
import type {Id} from "../../../../convex/_generated/dataModel";
import {apiIdentity} from "../../../../src/api-auth";
import {backend} from "../../../../src/server";
export async function POST(request:Request){
 try{
  const {token,organizationId}=await apiIdentity(request),reader=request.body?.getReader();
  if(!reader)throw new Error("Missing body");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096)return Response.json({error:"P4 review request exceeds 4 KB"},{status:413});chunks.push(value);}}finally{await reader.cancel();}
  const input=z.object({repositoryId:z.string().regex(/^[a-z0-9]{20,64}$/),nativeNumber:z.number().int().positive().safe(),force:z.boolean().optional()}).strict().parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
  const reviewId=await backend().action(api.p4ReviewJobs.request,{token,organizationId,repositoryId:input.repositoryId as Id<"repositories">,nativeNumber:input.nativeNumber,force:input.force});
  return Response.json({reviewId},{status:202});
 }catch{return Response.json({error:"P4 review request rejected; check workspace admin access, completed indexing and the current open archived shelf"},{status:400});}
}
