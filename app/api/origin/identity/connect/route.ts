import {randomBytes} from 'node:crypto';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {api} from '../../../../../convex/_generated/api';
import type {Id} from '../../../../../convex/_generated/dataModel';
import {current,backend,seal,cookieOptions,origin} from '../../../../../src/server';
export async function GET(request:Request){
 try{
  const identity=await current(),values=new URL(request.url).searchParams.getAll('repository');if(values.length!==1||!values[0])throw new Error('Select an Origin repository');
  const repositoryId=values[0] as Id<'repositories'>,connection=await backend().query(api.providerIdentities.originStart,{token:identity.token,secret:process.env.SERVICE_SECRET??'',repositoryId}),state=randomBytes(32).toString('hex');
  (await cookies()).set('openreview_origin_identity',await seal({state,repositoryId,userId:identity.user._id,digest:connection.digest}),{...cookieOptions,maxAge:300});
  return NextResponse.redirect('https://cursor.com/codebase/apps/user-confirmation?'+new URLSearchParams({installation_id:connection.installationId,redirect_uri:origin()+'/api/origin/identity/callback',state}));
 }catch{return NextResponse.json({error:'Cannot start Origin identity confirmation. Check repository access and the active installation.'},{status:400});}
}
