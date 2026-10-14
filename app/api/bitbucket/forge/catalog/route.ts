import {verifyBitbucketForge,forgeRepositories} from "../../../../../src/bitbucket-forge";

export async function POST(request:Request){
 const headers={"cache-control":"no-store"};
 const app=process.env.BITBUCKET_FORGE_APP_ID,environment=process.env.BITBUCKET_FORGE_ENVIRONMENT_ID;
 if(!app||!environment)return Response.json({error:"Bitbucket Forge registration is required"},{status:503,headers});
 let identity;
 try{identity=await verifyBitbucketForge(request.headers.get("authorization")??"",app,environment);}catch{return Response.json({error:"Invalid Forge invocation"},{status:401,headers});}
 try{
  const repositories=await forgeRepositories(identity.workspaceId,request.headers.get("x-forge-oauth-system")??"");
  return Response.json({...identity,repositories},{headers});
 }catch{return Response.json({error:"Bitbucket repository discovery unavailable"},{status:503,headers});}
}
