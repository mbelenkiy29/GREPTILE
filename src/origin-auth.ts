import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { importPKCS8, SignJWT, jwtVerify, createLocalJWKSet } from "jose";
import { z } from "zod";

export const originApi="https://api.cursor.com/v1/origin";
export const originScopes=["repository:metadata:read","repository:contents:read","repository:pull_requests:read","repository:pull_requests:reviews:read","repository:pull_requests:reviews:write","repository:checks:read"];
export const originPersonalScope="namespace:user_tokens:write";
export const originInstallationId=z.string().regex(/^(?:inst|i)_[a-z0-9]+$/);
export const originPersonalIdentity=z.object({userId:z.string().regex(/^user_[a-zA-Z0-9]+$/),installationId:originInstallationId,namespaceId:z.string().regex(/^ns_[a-z0-9]+$/)});
export const originCredentials=z.object({appId:z.string().regex(/^app_[a-z0-9]+$/),privateKey:z.string().min(50),installationId:originInstallationId});
const jwk=z.object({kty:z.literal("OKP"),crv:z.literal("Ed25519"),x:z.string(),kid:z.string(),alg:z.literal("EdDSA").optional()});
const keySchema=z.object({keys:z.array(jwk).min(1)});
let cachedKeys:{keys:z.infer<typeof keySchema>;expiresAt:number}|undefined;
let forcedRefreshAt=0;
function refreshSigningKeys(){
 // ponytail: per-process refresh throttle; use shared rate limiting if webhook traffic spans many isolates.
 if(Date.now()-forcedRefreshAt<30000)return;
 forcedRefreshAt=Date.now();cachedKeys=undefined;
}
async function publicKeys(){
 if(cachedKeys&&cachedKeys.expiresAt>Date.now())return cachedKeys.keys;
 const response=await fetch(originApi+"/keys",{redirect:"error",signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error("Origin signing keys unavailable");
 const keys=keySchema.parse(await response.json());cachedKeys={keys,expiresAt:Date.now()+600000};return keys;
}
export async function originInstallationToken(credentials:z.infer<typeof originCredentials>){
 const c=originCredentials.parse(credentials);
 const key=await importPKCS8(c.privateKey,"EdDSA");
 const jwt=await new SignJWT({}).setProtectedHeader({alg:"EdDSA",kid:c.appId,typ:"JWT"}).setIssuer(c.appId).setAudience("origin-apps").setIssuedAt().setExpirationTime("5m").sign(key);
 const response=await fetch(originApi+"/app/installations/"+encodeURIComponent(c.installationId)+"/access_tokens",{method:"POST",redirect:"error",headers:{authorization:"Bearer "+jwt,"content-type":"application/json"},body:JSON.stringify({scopes:originScopes}),signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error("Origin installation authentication rejected ("+response.status+")");
 const token=z.object({token:z.string().startsWith("oit_"),expiresAt:z.string().datetime({offset:true})}).parse(await response.json());
 if(Date.parse(token.expiresAt)<=Date.now() || Date.parse(token.expiresAt)>Date.now()+15*60000)throw new Error("Origin returned an invalid installation-token expiry");
 return token;
}
export async function verifyOriginReceipt(receipt:string,appId:string,state:string){
 const verifyReceipt=async()=>jwtVerify(receipt,createLocalJWKSet(await publicKeys()),{algorithms:["EdDSA"],issuer:originApi,audience:appId,typ:"origin-installation-receipt+jwt",maxTokenAge:"5m"});
 let verified;
 try{verified=await verifyReceipt();}catch(error){
  if(!(error instanceof Error)||error.name!=="JWKSNoMatchingKey")throw error;
  refreshSigningKeys();verified=await verifyReceipt();
 }
 const payload=z.object({sub:originInstallationId,state:z.string(),jti:z.string().min(1).max(200),namespace_id:z.string().regex(/^ns_[a-z0-9]+$/),exp:z.number(),iat:z.number()}).parse(verified.payload);
 if(payload.state!==state || !state || payload.exp-payload.iat>300)throw new Error("Origin installation receipt state or lifetime invalid");
 return payload;
}
export async function verifyOriginUserReceipt(receipt:string,appId:string,state:string,installationId:string,namespaceId:string){
 const check=async()=>jwtVerify(receipt,createLocalJWKSet(await publicKeys()),{algorithms:["EdDSA"],issuer:originApi,audience:appId,typ:"origin-user-confirmation-receipt+jwt",maxTokenAge:"5m"});
 let verified;try{verified=await check();}catch(error){if(!(error instanceof Error)||error.name!=="JWKSNoMatchingKey")throw error;refreshSigningKeys();verified=await check();}
 const p=z.object({sub:z.string().regex(/^user_[a-zA-Z0-9]+$/),installation_id:originInstallationId,namespace_id:z.string().regex(/^ns_[a-z0-9]+$/),state:z.string(),jti:z.string().min(1).max(200),exp:z.number(),iat:z.number()}).parse(verified.payload);
 if(!state||p.state!==state||p.installation_id!==installationId||p.namespace_id!==namespaceId||p.exp-p.iat>300||p.exp<=p.iat)throw new Error("Origin user confirmation state, installation or lifetime invalid");
 return p;
}
/** Mint only read access for the confirmed user and exact primary repository. Never persist the token. */
async function originReadAccess(credentials:z.infer<typeof originCredentials>,personal:z.infer<typeof originPersonalIdentity>,repositoryId:string){
 const c=originCredentials.parse(credentials),p=originPersonalIdentity.parse(personal);
 if(c.installationId!==p.installationId||!/^(?:r|repo)_[a-zA-Z0-9]+$/.test(repositoryId))throw new Error("Origin personal installation or repository mismatch");
 const jwtExpiresAt=Math.floor(Date.now()/1000)+300,key=await importPKCS8(c.privateKey,"EdDSA"),jwt=await new SignJWT({}).setProtectedHeader({alg:"EdDSA",kid:c.appId,typ:"JWT"}).setIssuer(c.appId).setAudience("origin-apps").setIssuedAt().setExpirationTime(jwtExpiresAt).sign(key);
 const response=await fetch(originApi+"/app/installations/"+encodeURIComponent(c.installationId)+"/user_access_tokens",{method:"POST",redirect:"error",headers:{authorization:"Bearer "+jwt,"content-type":"application/json"},body:JSON.stringify({userId:p.userId,scopes:["repository:metadata:read","repository:contents:read","repository:pull_requests:read"],repositoryIds:[repositoryId]}),signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error("Origin personal access rejected ("+response.status+")");
 const token=z.object({token:z.string().min(1).max(20000),expiresAt:z.string().datetime({offset:true})}).parse(await response.json());
 if(Date.parse(token.expiresAt)<=Date.now()||Date.parse(token.expiresAt)>jwtExpiresAt*1000)throw new Error("Origin personal token expiry invalid");
 const native=await fetch(originApi+"/repos/_/"+encodeURIComponent(repositoryId),{redirect:"error",headers:{authorization:"Bearer "+token.token},signal:AbortSignal.timeout(30000)});
 if(!native.ok)throw new Error("Origin personal repository access rejected ("+native.status+")");
 const repository=z.object({id:z.string(),owner:z.object({id:z.string()})}).parse(await native.json());
 if(repository.id!==repositoryId||repository.owner.id!==p.namespaceId)throw new Error("Origin personal repository identity changed");
 return {externalId:p.userId,username:p.userId,token:token.token};
}
export async function originUserAccess(credentials:z.infer<typeof originCredentials>,personal:z.infer<typeof originPersonalIdentity>,repositoryId:string){
 const {externalId,username}=await originReadAccess(credentials,personal,repositoryId);return {externalId,username};
}
/** Inspect native grants with a confirmed read-only token; never act as the user to write. */
export async function originUserCanReply(credentials:z.infer<typeof originCredentials>,personal:z.infer<typeof originPersonalIdentity>,repositoryId:string){
 const access=await originReadAccess(credentials,personal,repositoryId);
 const response=await fetch(originApi+'/repos/_/'+encodeURIComponent(repositoryId)+'/collaborators/'+encodeURIComponent(access.externalId)+'/permission',{redirect:'error',headers:{authorization:'Bearer '+access.token},signal:AbortSignal.timeout(30000)});
 if(response.status===404)return false;
 if(!response.ok)throw new Error('Origin personal permission unavailable ('+response.status+')');
 const result=z.object({user:z.object({id:z.string()}),permission:z.enum(['read','write','admin','custom'])}).parse(await response.json());
 return result.user.id===access.externalId&&['write','admin'].includes(result.permission);
}
export function verifyOriginSignature(body:string,id:string,timestamp:string,signature:string,keys:JsonWebKey[],now=Date.now()){
 if(!id||id.length>200||!/^\d+$/.test(timestamp)||Math.abs(now-Number(timestamp)*1000)>300000)return false;
 const digest=Buffer.from(createHash("sha256").update(id+"."+timestamp+"."+body).digest("hex"),"utf8");
 for(const entry of signature.split(/\s+/)) {
  if(!/^v1ed,[A-Za-z0-9+/]{86}==$/.test(entry))continue;
  const signed=Buffer.from(entry.slice(5),"base64");
  for(const key of keys){try{if(key.kty==="OKP"&&key.crv==="Ed25519"&&verify(null,digest,createPublicKey({key,format:"jwk"}),signed))return true;}catch{/* Reject malformed keys without accepting another algorithm. */}}
 }
 return false;
}
export async function verifyOriginWebhook(body:string,id:string,timestamp:string,signature:string){
 if(!id||id.length>200||!/^\d+$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp)*1000)>300000||!signature.split(/\s+/).some(s=>/^v1ed,[A-Za-z0-9+/]{86}==$/.test(s)))return false;
 let keys=await publicKeys();
 if(verifyOriginSignature(body,id,timestamp,signature,keys.keys))return true;
 refreshSigningKeys();keys=await publicKeys();
 return verifyOriginSignature(body,id,timestamp,signature,keys.keys);
}
