import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Atlassian,atlassianAuthorization,atlassianToken,atlassianScopes,AtlassianError} from '../src/atlassian';

test('Atlassian native read adapter pins sites/resources/content, rotates OAuth tokens and rejects scope leaks and incomplete paging',async()=>{
 const original=globalThis.fetch,calls:{url:URL;init:RequestInit|undefined}[]=[];
 const site={id:'11111111-1111-4111-8111-111111111111',name:'Requirements',url:'https://requirements.atlassian.net',scopes:atlassianScopes};
 let outside=false,moved=false,paging=false,forbidden=false,malicious=false,broad=false,invalidDocument=false,unauthorized=false;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push({url,init});
  assert.equal(init?.redirect,'error');
  if(url.hostname==='auth.atlassian.com'){
   const body=JSON.parse(String(init?.body));assert.equal(body.client_secret,'private-client-secret');
   if(body.grant_type==='refresh_token')assert.equal(body.refresh_token,'old-refresh-token');
   return Response.json({access_token:'new-access-token',refresh_token:'new-refresh-token',expires_in:3600,scope:[...atlassianScopes,...(broad?['write:jira-work']:[])].join(' ')});
  }
  if(unauthorized)return new Response('private response omitted',{status:401});
  assert.equal(url.origin,'https://api.atlassian.com');assert.equal((init?.headers as Record<string,string>).authorization,'Bearer fixture-token');
  if(url.pathname==='/oauth/token/accessible-resources')return Response.json(forbidden?[]:[site]);
  if(url.pathname.endsWith('/project/search'))return Response.json({startAt:Number(url.searchParams.get('startAt')),isLast:!paging,values:paging?[]:[{id:'10',name:'Billing',key:'PAY'}]});
  if(url.pathname.endsWith('/spaces'))return Response.json({results:[{id:'20',name:'Specifications',key:'SPEC'}],_links:{...(malicious?{next:'https://attacker.example/wiki/api/v2/spaces?cursor=stolen'}:{})}});
  if(url.pathname.includes('/issue/')){
   const full=url.searchParams.get('fields')!=='project';
   return Response.json({id:'30',key:'PAY-1',fields:{project:{id:outside||full&&moved?'99':'10'},...(full?{summary:'Preserve integer cents',description:{type:'doc',version:1,content:[{type:'text',text:'Price remains in cents.'}]},updated:'2026-10-02T00:00:00.000+0000'}:{})}});
  }
  if(url.pathname.endsWith('/pages/40')){
   const full=url.searchParams.has('body-format');
   return Response.json({id:'40',spaceId:outside||full&&moved?'99':'20',status:'current',...(full?{title:'Money units',version:{number:7},body:{atlas_doc_format:{representation:'atlas_doc_format',value:JSON.stringify(invalidDocument?{unexpected:'malformed document'}:{type:'doc',version:1,content:[{type:'text',text:'Integer cents only.'}]})}}}:{})});
  }
  throw new Error('Unexpected native path '+url.pathname);
 };
 try{
  const auth=new URL(atlassianAuthorization('client-id','http://localhost:3000/api/integrations/atlassian/callback','s'.repeat(43)));
  assert.equal(auth.origin,'https://auth.atlassian.com');assert.equal(auth.searchParams.get('audience'),'api.atlassian.com');assert.deepEqual(auth.searchParams.get('scope')?.split(' '),atlassianScopes);
  assert.throws(()=>atlassianAuthorization('client-id','http://attacker.example/callback','s'.repeat(43)));
  const refreshed=await atlassianToken('client-id','private-client-secret',{refreshToken:'old-refresh-token'});assert.equal(refreshed.refreshToken,'new-refresh-token');assert.ok(refreshed.expiresAt>Date.now());
  broad=true;await assert.rejects(atlassianToken('client-id','private-client-secret',{refreshToken:'old-refresh-token'}),/read-only/);broad=false;
  const client=new Atlassian('fixture-token');
  assert.deepEqual(await client.resources(site),{projects:[{id:'10',name:'Billing',key:'PAY'}],spaces:[{id:'20',name:'Specifications',key:'SPEC'}]});
  const issue=await client.issue(site,'PAY-1',['10']);assert.equal(issue.url,site.url+'/browse/PAY-1');assert.equal(issue.revision,'2026-10-02T00:00:00.000+0000');assert.match(issue.description,/cents/);
  const page=await client.page(site,'40',['20']);assert.equal(page.revision,'7');assert.equal(page.url,site.url+'/wiki/pages/viewpage.action?pageId=40');assert.match(page.description,/Integer cents/);
  outside=true;calls.length=0;await assert.rejects(client.issue(site,'PAY-1',['10']),/outside/);await assert.rejects(client.page(site,'40',['20']),/outside/);
  assert.ok(calls.every(c=>!c.url.searchParams.has('body-format')&&!c.url.searchParams.get('fields')?.includes('description')));
  outside=false;moved=true;await assert.rejects(client.issue(site,'PAY-1',['10']),/moved/);await assert.rejects(client.page(site,'40',['20']),/moved/);moved=false;
  paging=true;await assert.rejects(client.resources(site),/pagination incomplete/);paging=false;
  malicious=true;await assert.rejects(client.resources(site),/pagination incomplete/);malicious=false;
  invalidDocument=true;await assert.rejects(client.page(site,'40',['20']));invalidDocument=false;
  unauthorized=true;await assert.rejects(client.sites(),error=>error instanceof AtlassianError&&error.status===401&&!error.message.includes('private'));unauthorized=false;
  forbidden=true;await assert.rejects(client.issue(site,'PAY-1',['10']),/no longer authorized/);
  await assert.rejects(client.issue(site,'PAY-1?fields=secret',['10']),/valid issue/);
  assert.ok(calls.every(c=>!c.init?.method||c.init.method==='POST'&&c.url.hostname==='auth.atlassian.com'));
  assert.equal(new AtlassianError('Unavailable',401).status,401);
 }finally{globalThis.fetch=original;}
});
