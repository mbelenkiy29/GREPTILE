import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
function key(){const secret=process.env.CREDENTIAL_ENCRYPTION_KEY;if(!secret||secret.length<32)throw new Error("Configure CREDENTIAL_ENCRYPTION_KEY (32+ random characters) before connecting a provider");return createHash("sha256").update(secret).digest();}
export function encryptCredential(value:string,scope:string){const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(),iv);cipher.setAAD(Buffer.from(scope));const data=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(b=>b.toString("base64url")).join(".");}
export function decryptCredential(value:string,scope:string){const parts=value.split(".");if(parts.length!==3)throw new Error("Invalid credential");const [iv,tag,data]=parts.map(p=>Buffer.from(p,"base64url"));const cipher=createDecipheriv("aes-256-gcm",key(),iv);cipher.setAAD(Buffer.from(scope));cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]).toString("utf8");}
export function providerOrigin(raw:string,builtin:string[]=[]){
 const u=new URL(raw);
 if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)throw new Error("Provider instance requires HTTPS without credentials, query, or fragment");
 const allowed=[...builtin,...(process.env.SCM_ALLOWED_HOSTS??"").split(",").map(x=>x.trim())];
 if(!allowed.includes(u.host))throw new Error("Operator must authorize this instance in SCM_ALLOWED_HOSTS");
 return u.origin+u.pathname.replace(/\/$/,"");
}
