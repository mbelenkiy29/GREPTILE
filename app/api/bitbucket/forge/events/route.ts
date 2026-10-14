import {ConvexHttpClient} from "convex/browser";
import {api} from "../../../../../convex/_generated/api";
import {verifyBitbucketForge} from "../../../../../src/bitbucket-forge";
import {bitbucketEvent} from "../../../../../src/bitbucket-events";

export async function POST(request:Request){
 const headers={"cache-control":"no-store"},app=process.env.BITBUCKET_FORGE_APP_ID,environment=process.env.BITBUCKET_FORGE_ENVIRONMENT_ID,url=process.env.NEXT_PUBLIC_CONVEX_URL,secret=process.env.SERVICE_SECRET;
 if(!app||!environment||!url||!secret)return Response.json({error:"Bitbucket Forge setup is required"},{status:503,headers});
 let identity;
 try{identity=await verifyBitbucketForge(request.headers.get("authorization")??"",app,environment);}catch{return Response.json({error:"Invalid Forge invocation"},{status:401,headers});}
 if(identity.principal||identity.module?.type!=="core:endpoint"||identity.module.key!=="openreview-events")return Response.json({error:"Direct Forge product event endpoint required"},{status:403,headers});
 let body;
 try{
  const reader=request.body?.getReader();if(!reader)throw new Error("Missing body");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>400000)throw new Error("Too large");chunks.push(value);}}finally{await reader.cancel();}
  const event=bitbucketEvent.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
  if(event.workspace.uuid!==identity.workspaceId)return Response.json({error:"Event workspace does not match Forge installation"},{status:403,headers});
  body=JSON.stringify(event);
 }catch{return Response.json({error:"Invalid native Bitbucket event"},{status:400,headers});}
 try{
  await new ConvexHttpClient(url).mutation(api.providerInstalls.bitbucketEvent,{secret,installationId:identity.installationId,workspaceId:identity.workspaceId,invocationId:identity.invocationId,invocationExpiresAt:identity.invocationExpiresAt,body});
  return Response.json({status:"accepted"},{status:202,headers});
 }catch{return Response.json({error:"Forge event delivery rejected"},{status:403,headers});}
}
