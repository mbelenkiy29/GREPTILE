import {z} from 'zod';
import {providerOrigin} from './credentials';
// Atlassian's authenticated response header establishes the account; user search alone cannot.
export async function authenticatedBitbucketIdentity(instance:string,token:string){
 if(!token||token.length>4096||/[\r\n]/.test(token))throw new Error('Invalid personal access token');
 const base=providerOrigin(instance),headers={authorization:'Bearer '+token,accept:'application/json'},get=async(path:string)=>{const response=await fetch(base+'/rest/api/latest'+path,{redirect:'error',headers,signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Personal Bitbucket identity could not be authenticated');return response;};
 const first=await get('/application-properties'),username=first.headers.get('X-AUSERNAME');await first.body?.cancel();
 if(!username||username!==username.trim()||username.length>255||/[\u0000-\u001f\u007f]/.test(username)||username.toLowerCase()==='anonymous')throw new Error('Bitbucket must expose the authenticated X-AUSERNAME identity header');
 const user=z.object({id:z.number().int().positive(),name:z.string().min(1),active:z.boolean(),type:z.string()}),page=z.object({start:z.number().int().nonnegative(),isLastPage:z.boolean(),nextPageStart:z.number().int().nonnegative().optional(),values:z.array(user).max(100)}),matches:z.infer<typeof user>[]=[];
 let start=0;
 for(let count=0;count<10;count++){
  const response=await get('/users?filter='+encodeURIComponent(username)+'&limit=100&start='+start);
  if(response.headers.get('X-AUSERNAME')!==username){await response.body?.cancel();throw new Error('Bitbucket authenticated identity changed during verification');}
  const result=page.parse(await response.json());if(result.start!==start)throw new Error('Bitbucket identity search cursor mismatch');matches.push(...result.values.filter(u=>u.name===username));
  if(result.isLastPage){if(matches.length!==1||!matches[0].active||matches[0].type!=='NORMAL')throw new Error('Bitbucket authenticated personal account is inactive, ambiguous or unavailable');return {externalId:String(matches[0].id),username:matches[0].name};}
  if(result.nextPageStart===undefined||result.nextPageStart<=start)throw new Error('Bitbucket identity search pagination did not advance');start=result.nextPageStart;
 }
 throw new Error('Bitbucket identity search exceeded its verification limit');
}
