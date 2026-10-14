import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {api} from '../../../../../convex/_generated/api';
import type {Id} from '../../../../../convex/_generated/dataModel';
import {current,backend,unseal,origin} from '../../../../../src/server';
export async function GET(request:Request){
 const jar=await cookies(),cookie=jar.get('openreview_origin_identity')?.value;jar.delete('openreview_origin_identity');
 try{
  const identity=await current();if(!cookie)throw new Error('Missing confirmation session');
  const saved=z.object({state:z.string().min(1),repositoryId:z.string(),userId:z.string(),digest:z.string()}).parse(await unseal(cookie));if(saved.userId!==identity.user._id)throw new Error('Confirmation account changed');
  const receipts=new URL(request.url).searchParams.getAll('confirmation_receipt');if(receipts.length!==1||!receipts[0]||receipts[0].length>20000)throw new Error('Missing confirmation receipt');
  await backend().action(api.providerIdentityJobs.connectOrigin,{token:identity.token,secret:process.env.SERVICE_SECRET??'',repositoryId:saved.repositoryId as Id<'repositories'>,state:saved.state,digest:saved.digest,receipt:receipts[0]});
  return NextResponse.redirect(origin()+'/dashboard/settings/agents');
 }catch{return NextResponse.json({error:'Origin identity confirmation failed. Retry from Personal settings; check namespace:user_tokens:write, current membership and repository permissions.'},{status:400});}
}
