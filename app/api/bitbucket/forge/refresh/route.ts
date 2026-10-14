import {ConvexHttpClient} from "convex/browser";
import {z} from "zod";
import {api} from "../../../../../convex/_generated/api";
import {verifyBitbucketForge,verifyForgePublisher} from "../../../../../src/bitbucket-forge";
import {decryptCredential,encryptCredential} from "../../../../../src/credentials";

export async function POST(request:Request){
 const headers={"cache-control":"no-store"},app=process.env.BITBUCKET_FORGE_APP_ID,environment=process.env.BITBUCKET_FORGE_ENVIRONMENT_ID,url=process.env.NEXT_PUBLIC_CONVEX_URL,secret=process.env.SERVICE_SECRET;
 if(!app||!environment||!url||!secret)return Response.json({error:"Bitbucket Forge setup is required"},{status:503,headers});
 let identity;
 try{identity=await verifyBitbucketForge(request.headers.get("authorization")??"",app,environment);}catch{return Response.json({error:"Invalid Forge invocation"},{status:401,headers});}
 if(identity.principal||identity.module?.type!=="core:endpoint"||identity.module.key!=="openreview-token-refresh")return Response.json({error:"Direct Forge refresh endpoint required"},{status:403,headers});
 try{
  const client=new ConvexHttpClient(url),c=await client.query(api.providerInstalls.bitbucketInstallation,{secret,installationId:identity.installationId,workspaceId:identity.workspaceId});
  const scope=c.organizationId+":bitbucket-cloud",previous=z.object({publisherId:z.string().uuid(),invocationIssuedAt:z.number().optional()}).parse(JSON.parse(decryptCredential(c.credentials,scope)));
  if(previous.invocationIssuedAt!==undefined&&identity.invocationIssuedAt<previous.invocationIssuedAt)throw new Error("Older invocation");
  const systemToken=request.headers.get("x-forge-oauth-system")??"",publisherId=await verifyForgePublisher(systemToken);
  if(publisherId!==previous.publisherId)throw new Error("Publisher changed");
  const receivedAt=Date.now(),credentials=encryptCredential(JSON.stringify({systemToken,publisherId,invocationIssuedAt:identity.invocationIssuedAt,receivedAt,expiresAt:receivedAt+90*60000}),scope);
  await client.mutation(api.providerInstalls.refreshBitbucket,{secret,id:c.id,installationId:identity.installationId,workspaceId:identity.workspaceId,previousCredentials:c.credentials,credentials,invocationId:identity.invocationId,invocationExpiresAt:identity.invocationExpiresAt});
  return Response.json({status:"refreshed"},{headers});
 }catch{return Response.json({error:"Forge installation refresh rejected"},{status:403,headers});}
}
