import {ConvexHttpClient} from "convex/browser";
import {api} from "../../../../../convex/_generated/api";
import {verifyBitbucketForge} from "../../../../../src/bitbucket-forge";

export async function POST(request:Request){
 const headers={"cache-control":"no-store"},app=process.env.BITBUCKET_FORGE_APP_ID,environment=process.env.BITBUCKET_FORGE_ENVIRONMENT_ID,url=process.env.NEXT_PUBLIC_CONVEX_URL,secret=process.env.SERVICE_SECRET;
 if(!app||!environment||!url||!secret)return Response.json({error:"Bitbucket Forge setup is required"},{status:503,headers});
 let identity;
 try{identity=await verifyBitbucketForge(request.headers.get("authorization")??"",app,environment);}catch{return Response.json({error:"Invalid Forge invocation"},{status:401,headers});}
 if(identity.principal||identity.module?.type!=="core:endpoint"||identity.module.key!=="openreview-uninstall")return Response.json({error:"Direct Forge pre-uninstall endpoint required"},{status:403,headers});
 try{
  await new ConvexHttpClient(url).mutation(api.providerInstalls.uninstallBitbucket,{secret,installationId:identity.installationId,workspaceId:identity.workspaceId,invocationId:identity.invocationId,invocationExpiresAt:identity.invocationExpiresAt});
  return Response.json({status:"disconnected"},{headers});
 }catch{return Response.json({error:"Forge uninstall rejected"},{status:403,headers});}
}
