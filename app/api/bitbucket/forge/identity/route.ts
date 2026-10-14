import {createHash} from 'node:crypto';
import {ConvexHttpClient} from 'convex/browser';
import {z} from 'zod';
import {api} from '../../../../../convex/_generated/api';
import {verifyBitbucketForge,verifyForgePersonalAccess} from '../../../../../src/bitbucket-forge';
import {encryptCredential} from '../../../../../src/credentials';
export async function POST(request:Request){
 const headers={'cache-control':'no-store'},app=process.env.BITBUCKET_FORGE_APP_ID,environment=process.env.BITBUCKET_FORGE_ENVIRONMENT_ID,url=process.env.NEXT_PUBLIC_CONVEX_URL,secret=process.env.SERVICE_SECRET;
 if(!app||!environment||!url||!secret)return Response.json({error:'Forge setup required'},{status:503,headers});
 let identity;try{identity=await verifyBitbucketForge(request.headers.get('authorization')??'',app,environment);}catch{return Response.json({error:'Invalid Forge invocation'},{status:401,headers});}
 if(!identity.principal)return Response.json({error:'Native personal session required'},{status:403,headers});
 let tokenHash;
 try{
  const reader=request.body?.getReader();if(!reader)throw new Error('Missing body');const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024)throw new Error('Too large');chunks.push(value);}}finally{await reader.cancel();}
  const {code}=z.object({code:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));tokenHash=createHash('sha256').update(code).digest('hex');
 }catch{return Response.json({error:'Valid personal authorization required'},{status:400,headers});}
 try{
  const client=new ConvexHttpClient(url),g=await client.query(api.bitbucketPersonal.inspect,{secret,tokenHash});
  if(identity.installationId!==g.installationId||identity.workspaceId!==g.workspaceId)throw new Error('Installation changed');
  const verified=await verifyForgePersonalAccess(identity,request.headers.get('x-forge-oauth-user')??'',g.externalId,g.fullName);
  const result=await client.mutation(api.bitbucketPersonal.save,{secret,tokenHash,digest:g.digest,installationId:identity.installationId,workspaceId:identity.workspaceId,invocationId:identity.invocationId,invocationExpiresAt:identity.invocationExpiresAt,externalId:verified.externalId,username:verified.username,expiresAt:verified.credential.expiresAt,credentials:encryptCredential(JSON.stringify(verified.credential),g.organizationId+':provider-personal:'+g.connectionId+':'+g.userId)});
  return Response.json({status:'linked',expiresAt:result.expiresAt},{headers});
 }catch{return Response.json({error:'Personal authorization or native access verification failed. Generate a fresh code in OpenReview.'},{status:403,headers});}
}
