import {createRemoteJWKSet,customFetch,jwtVerify} from "jose";
import {z} from "zod";

const keys=createRemoteJWKSet(new URL("https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json"),{[customFetch]:(url,options)=>fetch(url,{...options,redirect:"error"})});
const uuid=z.string().uuid();
const workspaceId=z.string().transform(s=>s.replace(/^\{(.+)\}$/,"$1")).pipe(uuid);
const claims=z.object({
 app:z.object({id:z.string(),environment:z.object({id:z.string()}),module:z.object({type:z.string(),key:z.string()}).optional(),installationId:z.string().optional(),installation:z.object({id:z.string().refine(s=>s.startsWith("ari:cloud:ecosystem::installation/")&&uuid.safeParse(s.slice("ari:cloud:ecosystem::installation/".length)).success),contexts:z.array(z.object({name:z.string(),apiBaseUrl:z.string(),workspaceId:workspaceId.optional()})).min(1).max(20)})}),
 context:z.object({workspaceId:workspaceId.optional()}).optional(),principal:z.string().min(1).max(200).optional(),icLabel:z.unknown().optional(),jti:z.string().min(1).max(200),
});
export async function verifyBitbucketForge(authorization:string,appId:string,environmentId:string){
 const appUuid=appId.replace(/^ari:cloud:ecosystem::app\//,"");
 if(!uuid.safeParse(appUuid).success||appId!=="ari:cloud:ecosystem::app/"+appUuid||!environmentId.startsWith("ari:cloud:ecosystem::environment/"+appUuid+"/")||!uuid.safeParse(environmentId.split("/")[2]).success)throw new Error("Configure the registered Forge app and environment");
 if(!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)||authorization.length>30000)throw new Error("Forge invocation authentication required");
 const {payload}=await jwtVerify(authorization.slice(7),keys,{issuer:"forge/invocation-token",audience:appId,algorithms:["RS256"],requiredClaims:["exp","iat","nbf","jti"],maxTokenAge:"5m"});
 const value=claims.parse(payload);
 if(value.app.id!==appId||value.app.environment.id!==environmentId||value.icLabel!==undefined)throw new Error("Forge app, environment or cloud mismatch");
 if(value.app.installationId!==undefined&&value.app.installationId!==value.app.installation.id)throw new Error("Forge installation context mismatch");
 const contexts=value.app.installation.contexts.filter(c=>c.name==="bitbucket");
 if(contexts.length!==1||contexts[0].apiBaseUrl!=="https://api.bitbucket.org"||!contexts[0].workspaceId)throw new Error("Unambiguous Bitbucket installation context required");
 const workspace=contexts[0].workspaceId;
 if(value.context?.workspaceId&&value.context.workspaceId!==workspace)throw new Error("Forge workspace context mismatch");
 return {installationId:value.app.installation.id,workspaceId:workspace,invocationId:value.jti,invocationExpiresAt:payload.exp!*1000,invocationIssuedAt:payload.iat!*1000,...(value.app.module?{module:value.app.module}:{}),...(value.principal?{principal:value.principal}:{})};
}

async function forgeRequest(endpoint:string,token:string){
 if(token.length<10||token.length>20000||/[\s\0]/.test(token))throw new Error("Forge OAuth token required");
 const url=new URL(endpoint,"https://api.bitbucket.org");
 if(url.origin!=="https://api.bitbucket.org"||url.username||url.password||url.hash||!url.pathname.startsWith("/2.0/"))throw new Error("Invalid Bitbucket Forge API path");
 const response=await fetch(url,{headers:{authorization:"Bearer "+token,accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error("Bitbucket Forge API unavailable ("+response.status+")");
 const reader=response.body?.getReader();if(!reader)throw new Error("Bitbucket response missing");
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4000000)throw new Error("Bitbucket response exceeds coverage limit");chunks.push(value);}}finally{await reader.cancel();}
 return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
}

export async function verifyForgePublisher(systemToken:string){
 const publisher=z.object({uuid:workspaceId,type:z.literal("app_user"),account_id:z.string().min(1).max(200),account_status:z.literal("active")}).parse(await forgeRequest("/2.0/user",systemToken));
 return publisher.uuid;
}

const personalAccount=z.object({uuid:workspaceId,type:z.literal("user"),account_id:z.string().min(1).max(200),account_status:z.literal("active")});
const personalCredentialSchema=z.object({userToken:z.string().min(10).max(20000).refine(s=>!/[\s\0]/.test(s)),nativeUserId:uuid,accountId:z.string().min(1).max(200),workspaceId:uuid,installationId:z.string().regex(/^ari:cloud:ecosystem::installation\/[0-9a-f-]+$/),receivedAt:z.number().finite(),expiresAt:z.number().finite()}).strict();
export function forgePersonalCredential(value:string){
 const c=personalCredentialSchema.parse(JSON.parse(value));
 uuid.parse(c.installationId.slice("ari:cloud:ecosystem::installation/".length));
 if(c.receivedAt>Date.now()+30000||c.expiresAt<=Date.now()||c.expiresAt<=c.receivedAt||c.expiresAt-c.receivedAt>60*60000)throw new Error("Bitbucket personal access expired; confirm your identity again in the installed Forge app");
 return c;
}
async function personalRepositoryAccess(userToken:string,accountId:string,workspace:string,repositoryId:string,fullName:string){
 const tenant=uuid.parse(workspace),selected=workspaceId.parse(repositoryId);
 const before=personalAccount.parse(await forgeRequest("/2.0/user",userToken));
 if(before.account_id!==accountId)throw new Error("Forge personal token does not match the invoking principal");
 const native=z.object({uuid:workspaceId,scm:z.literal("git"),full_name:z.string(),workspace:z.object({uuid:workspaceId})}).parse(await forgeRequest("/2.0/repositories/"+encodeURIComponent("{"+tenant+"}")+"/"+encodeURIComponent("{"+selected+"}"),userToken));
 if(native.uuid!==selected||native.workspace.uuid!==tenant||native.full_name!==fullName)throw new Error("Bitbucket personal repository identity changed");
 const after=personalAccount.parse(await forgeRequest("/2.0/user",userToken));
 if(after.account_id!==before.account_id||after.uuid!==before.uuid)throw new Error("Bitbucket personal identity changed during repository verification");
 return {externalId:before.uuid,username:"{"+before.uuid+"}"};
}
export async function verifyForgePersonalAccess(identity:Awaited<ReturnType<typeof verifyBitbucketForge>>,userToken:string,repositoryId:string,fullName:string){
 if(!identity.principal||identity.invocationExpiresAt<=Date.now()||identity.invocationIssuedAt>Date.now()+30000)throw new Error("Current signed Forge user invocation required");
 // Forge documents at least ~2 hours remaining. Keep a one-hour grant and treat OAuth bytes as opaque.
 const receivedAt=Date.now(),expiresAt=receivedAt+60*60000;
 const user=await personalRepositoryAccess(userToken,identity.principal,identity.workspaceId,repositoryId,fullName);
 const credential=forgePersonalCredential(JSON.stringify({userToken,nativeUserId:user.externalId,accountId:identity.principal,workspaceId:identity.workspaceId,installationId:identity.installationId,receivedAt,expiresAt}));
 return {...user,credential};
}
export async function revalidateForgePersonalAccess(value:string,installationId:string,workspace:string,repositoryId:string,fullName:string){
 const c=forgePersonalCredential(value);
 if(c.installationId!==installationId||c.workspaceId!==uuid.parse(workspace))throw new Error("Bitbucket personal installation authority changed");
 const user=await personalRepositoryAccess(c.userToken,c.accountId,c.workspaceId,repositoryId,fullName);
 if(user.externalId!==c.nativeUserId)throw new Error("Bitbucket personal account replaced");
 forgePersonalCredential(value);return user;
}
export async function verifyForgeConnectionAccess(identity:Awaited<ReturnType<typeof verifyBitbucketForge>>,userToken:string,systemToken:string){
 if(!identity.principal)throw new Error("Forge user invocation required for workspace connection");
 const tenant=uuid.parse(identity.workspaceId);
 const account=z.object({uuid:workspaceId,type:z.enum(["user","app_user"]),account_id:z.string().min(1).max(200),account_status:z.literal("active")});
 const user=account.parse(await forgeRequest("/2.0/user",userToken));
 if(user.type!=="user"||user.account_id!==identity.principal)throw new Error("Forge user token does not match the invoking principal");
 const publisher=await verifyForgePublisher(systemToken);
 if(publisher===user.uuid)throw new Error("Forge system token must identify the app publisher");
 const query=new URLSearchParams({q:'user.uuid="{'+user.uuid+'}"',pagelen:"100"});
 const first=new URL("/2.0/workspaces/"+encodeURIComponent("{"+tenant+"}")+"/permissions?"+query,"https://api.bitbucket.org"),seen=new Set<string>();
 const permission=z.object({permission:z.enum(["owner","member","collaborator"]),user:z.object({uuid:workspaceId}),workspace:z.object({uuid:workspaceId})});
 const rows:z.infer<typeof permission>[]=[];let next=first.href;
 // ponytail: bounded complete permission lookup; require a native scoped lookup if this exceeds 100 pages.
 for(let page=0;page<100;page++){
  const url=new URL(next);
  if(url.origin!==first.origin||url.pathname!==first.pathname||url.username||url.password||url.hash||url.searchParams.get("q")!==first.searchParams.get("q")||[...url.searchParams.keys()].some(k=>!["q","page","pagelen"].includes(k))||seen.has(url.href))throw new Error("Forge workspace permission pagination changed scope");
  seen.add(url.href);
  const data=z.object({values:z.array(permission).max(100),next:z.string().url().optional(),size:z.number().int().nonnegative().optional()}).parse(await forgeRequest(url.href,userToken));
  for(const row of data.values)if(row.user.uuid!==user.uuid||row.workspace.uuid!==tenant)throw new Error("Forge workspace permission identity mismatch");
  rows.push(...data.values);
  if(!data.next){
   if(data.size!==undefined&&data.size!==rows.length||rows.length!==1||rows[0].permission!=="owner")throw new Error("Native Bitbucket workspace owner access required");
 return {...identity,nativeUserId:user.uuid,publisherId:publisher};
  }
  if(!data.values.length)throw new Error("Forge workspace permission coverage incomplete");next=data.next;
 }
 throw new Error("Forge workspace permission enumeration exceeded");
}

export async function forgeRepositories(workspace:string,systemToken:string){
 const tenant=uuid.parse(workspace);
 if(systemToken.length<10||systemToken.length>20000||/[\s\0]/.test(systemToken))throw new Error("Forge app system token required");
 const prefix="/2.0/repositories/"+encodeURIComponent("{"+tenant+"}");
 const slug=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
 const repo=z.object({uuid:workspaceId,full_name:z.string().min(3).max(500),slug,scm:z.literal("git"),workspace:z.object({uuid:workspaceId,slug,name:z.string().max(2000)}),mainbranch:z.object({name:z.string().min(1).max(300)}).nullish()});
 const result:z.infer<typeof repo>[]=[];const seenPages=new Set<string>(),seenRepos=new Set<string>();
 let next="https://api.bitbucket.org"+prefix+"?pagelen=100";
 // ponytail: at most 10,000 repositories; partition discovery when a workspace exceeds this ceiling.
 for(let page=0;page<100;page++){
  const url=new URL(next);
  if(url.origin!=="https://api.bitbucket.org"||url.pathname!==prefix||url.username||url.password||url.hash||seenPages.has(url.href))throw new Error("Invalid or repeated Bitbucket repository page");
  seenPages.add(url.href);
  const data=z.object({values:z.array(repo).max(100),next:z.string().url().optional()}).parse(await forgeRequest(url.href,systemToken));
  for(const r of data.values){
   if(r.workspace.uuid!==tenant||r.full_name!==r.workspace.slug+"/"+r.slug||seenRepos.has(r.uuid))throw new Error("Bitbucket repository identity or workspace mismatch");
   seenRepos.add(r.uuid);result.push(r);
  }
  if(!data.next)return result.map(r=>({externalId:"{"+r.uuid+"}",fullName:r.full_name,defaultBranch:r.mainbranch?.name??null,remoteUrl:"https://bitbucket.org/"+r.full_name.split("/").map(encodeURIComponent).join("/")+".git",group:{externalId:tenant,name:(r.workspace.name.trim()||r.workspace.slug).slice(0,100)}}));
  if(!data.values.length)throw new Error("Empty Bitbucket page cannot certify complete discovery");
  next=data.next;
 }
 throw new Error("Bitbucket repository pagination exceeded; discovery incomplete");
}
