import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticatedProviderIdentity} from '../src/provider-identity';
test('personal provider verification pins account ID and rejects bots, inactive users, redirects and unapproved hosts',async t=>{
 process.env.SCM_ALLOWED_HOSTS='gitea.fixture';let body:unknown={id:42,username:'same-name',state:'active'},status=200,calls=0;
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{calls++;assert.equal(options.redirect,'error');assert.ok(input.endsWith('/user'));assert.ok(options.headers);return new Response(JSON.stringify(body),{status});});
 assert.deepEqual(await authenticatedProviderIdentity('gitlab','https://gitlab.com','personal-token'),{externalId:'42',username:'same-name'});
 body={id:42,username:'same-name',state:'active',bot:true};await assert.rejects(authenticatedProviderIdentity('gitlab','https://gitlab.com','personal-token'),/personal account/);
 body={id:42,username:'same-name',state:'blocked'};await assert.rejects(authenticatedProviderIdentity('gitlab','https://gitlab.com','personal-token'));
 body={id:77,login:'same-name',active:true,prohibit_login:false,type:'User'};assert.deepEqual(await authenticatedProviderIdentity('gitea','https://gitea.fixture','personal-token'),{externalId:'77',username:'same-name'});
 body={id:77,login:'same-name',active:true,prohibit_login:true,type:'User'};await assert.rejects(authenticatedProviderIdentity('gitea','https://gitea.fixture','personal-token'));
 status=401;await assert.rejects(authenticatedProviderIdentity('gitlab','https://gitlab.com','personal-token'),/authenticated/);
 const before=calls;await assert.rejects(authenticatedProviderIdentity('gitlab','https://foreign.fixture','personal-token'),/authorize/);await assert.rejects(authenticatedProviderIdentity('origin','https://gitea.fixture','personal-token'),/unavailable/);await assert.rejects(authenticatedProviderIdentity('gitlab','https://gitlab.com','token\r\nheader'),/Invalid/);assert.equal(calls,before);
});

test('GitHub Enterprise identities use authorized API hosts, preserve server hostnames and reject bots/suspension',async t=>{
 const {githubEnterpriseEndpoints,githubWebOrigin}=await import('../src/github-enterprise');
 process.env.SCM_ALLOWED_HOSTS='enterprise.fixture,api.server.fixture,tenant.ghe.com,api.tenant.ghe.com';let body:unknown={id:88,login:'native-user',type:'User'},calls=0;
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{calls++;assert.ok(['https://enterprise.fixture/api/v3/user','https://api.tenant.ghe.com/user'].includes(input));assert.equal(options.redirect,'error');assert.equal((options.headers as Record<string,string>).authorization,'Bearer personal-token');return new Response(JSON.stringify(body));});
 assert.deepEqual(githubEnterpriseEndpoints('https://enterprise.fixture/api/v3'),{api:'https://enterprise.fixture/api/v3',web:'https://enterprise.fixture'});
 assert.equal(githubWebOrigin('https://api.server.fixture/api/v3'),'https://api.server.fixture');assert.equal(githubWebOrigin('https://api.tenant.ghe.com'),'https://tenant.ghe.com');assert.equal(githubWebOrigin('https://api.github.com'),'https://github.com');
 for(const instance of ['https://enterprise.fixture','https://enterprise.fixture/api/v3','https://tenant.ghe.com','https://api.tenant.ghe.com'])assert.deepEqual(await authenticatedProviderIdentity('github-enterprise',instance,'personal-token'),{externalId:'88',username:'native-user'});
 body={id:88,login:'native-user',type:'Bot'};await assert.rejects(authenticatedProviderIdentity('github-enterprise','https://enterprise.fixture','personal-token'));
 body={id:88,login:'native-user',type:'User',suspended_at:'2026-10-01T00:00:00Z'};await assert.rejects(authenticatedProviderIdentity('github-enterprise','https://enterprise.fixture','personal-token'));
 process.env.SCM_ALLOWED_HOSTS='tenant.ghe.com';const before=calls;await assert.rejects(authenticatedProviderIdentity('github-enterprise','https://tenant.ghe.com','personal-token'),/authorize/);assert.equal(calls,before);
 assert.throws(()=>githubEnterpriseEndpoints('https://tenant.ghe.com/path'),/root/);assert.throws(()=>githubWebOrigin('https://api.server.fixture/unknown'),/Unsupported/);
});

test('Bitbucket Data Center identity requires authenticated headers and exact active immutable user lookup',async t=>{
 process.env.SCM_ALLOWED_HOSTS='bitbucket.fixture';let mode='ok',searches=0;
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  assert.equal(options.redirect,'error');assert.equal((options.headers as Record<string,string>).authorization,'Bearer personal-token');const u=new URL(input);assert.ok(u.pathname.startsWith('/bitbucket/rest/api/latest/'));
  if(mode==='unauthorized')return new Response('{}',{status:401});
  const headers:Record<string,string>=mode==='missing'?{}:{'X-AUSERNAME':mode==='anonymous'?'anonymous':mode==='changed'&&u.pathname.endsWith('/users')?'other':'alice'};
  if(u.pathname.endsWith('/application-properties'))return new Response('{}',{headers});
  searches++;assert.equal(u.searchParams.get('filter'),'alice');assert.equal(u.searchParams.get('limit'),'100');
  const values=mode==='wrong-user'?[{id:88,name:'alice-other',active:true,type:'NORMAL'}]:[{id:77,name:'alice',active:mode!=='inactive',type:mode==='service'?'SERVICE':'NORMAL'}];if(mode==='ambiguous')values.push({...values[0],id:89});
  return new Response(JSON.stringify({start:Number(u.searchParams.get('start')),isLastPage:mode!=='paged'&&mode!=='stuck',nextPageStart:mode==='stuck'?0:100,values}),{headers});
 });
 assert.deepEqual(await authenticatedProviderIdentity('bitbucket-dc','https://bitbucket.fixture/bitbucket','personal-token'),{externalId:'77',username:'alice'});
 for(const next of ['missing','anonymous','changed','wrong-user','inactive','service','ambiguous','stuck','unauthorized']){mode=next;await assert.rejects(authenticatedProviderIdentity('bitbucket-dc','https://bitbucket.fixture/bitbucket','personal-token'));}
 assert.ok(searches<20);
});

test('Bitbucket Data Center identity walks native cursors and rejects unbounded or mismatched account results',async t=>{
 process.env.SCM_ALLOWED_HOSTS='bitbucket.fixture';let mode='ok',calls=0;
 t.mock.method(globalThis,'fetch',async(input:string)=>{
  const u=new URL(input),headers={'X-AUSERNAME':'alice'};if(u.pathname.endsWith('/application-properties'))return new Response('{}',{headers});calls++;
  const start=Number(u.searchParams.get('start')),last=mode==='ok'&&start===250,values=start===250?[{id:77,name:'alice',active:true,type:'NORMAL'}]:[];
  return new Response(JSON.stringify({start:mode==='wrong-cursor'?start+1:start,isLastPage:last,nextPageStart:start===0?250:start+100,values}),{headers});
 });
 assert.deepEqual(await authenticatedProviderIdentity('bitbucket-dc','https://bitbucket.fixture','personal-token'),{externalId:'77',username:'alice'});assert.equal(calls,2);
 mode='wrong-cursor';await assert.rejects(authenticatedProviderIdentity('bitbucket-dc','https://bitbucket.fixture','personal-token'),/cursor mismatch/);
 mode='bounded';const before=calls;await assert.rejects(authenticatedProviderIdentity('bitbucket-dc','https://bitbucket.fixture','personal-token'),/verification limit/);assert.equal(calls-before,10);
});
