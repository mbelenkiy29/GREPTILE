import {createHash} from "node:crypto";
import {ConvexHttpClient} from "convex/browser";
import {z} from "zod";
import {api} from "../../../../../convex/_generated/api";
import {verifyBitbucketForge,verifyForgeConnectionAccess} from "../../../../../src/bitbucket-forge";
import {encryptCredential} from "../../../../../src/credentials";

export async function POST(request:Request){
 const headers={"cache-control":"no-store"};
 const app=process.env.BITBUCKET_FORGE_APP_ID,environment=process.env.BITBUCKET_FORGE_ENVIRONMENT_ID,url=process.env.NEXT_PUBLIC_CONVEX_URL,secret=process.env.SERVICE_SECRET;
 if(!app||!environment||!url||!secret)return Response.json({error:"Bitbucket Forge setup is required"},{status:503,headers});
 let identity;
 try{identity=await verifyBitbucketForge(request.headers.get("authorization")??"",app,environment);}catch{return Response.json({error:"Invalid Forge invocation"},{status:401,headers});}
 let tokenHash;
 try{
  const reader=request.body?.getReader();if(!reader)throw new Error("Missing body");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024)throw new Error("Too large");chunks.push(value);}}finally{await reader.cancel();}
  const {code}=z.object({code:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
  tokenHash=createHash("sha256").update(code).digest("hex");
 }catch{return Response.json({error:"A valid installation authorization code is required"},{status:400,headers});}
 try{
  const client=new ConvexHttpClient(url),grant=await client.query(api.providerInstalls.inspect,{secret,tokenHash});
  const systemToken=request.headers.get("x-forge-oauth-system")??"";
  const verified=await verifyForgeConnectionAccess(identity,request.headers.get("x-forge-oauth-user")??"",systemToken);
  // Only the app token is retained. Use less than the documented two-hour minimum TTL.
  const credentials=encryptCredential(JSON.stringify({systemToken,publisherId:verified.publisherId,invocationIssuedAt:verified.invocationIssuedAt,receivedAt:Date.now(),expiresAt:Date.now()+60*60000}),grant.organizationId+":bitbucket-cloud");
  const connectionId=await client.mutation(api.providerInstalls.connectBitbucket,{secret,tokenHash,installationId:verified.installationId,workspaceId:verified.workspaceId,invocationId:verified.invocationId,invocationExpiresAt:verified.invocationExpiresAt,credentials});
  return Response.json({connectionId,status:"suspended",message:"Installation connected. Await a signed event and scheduled token renewal, then activate this installation in OpenReview Settings."},{headers});
 }catch{return Response.json({error:"Installation authorization or native workspace-owner verification failed"},{status:403,headers});}
}
