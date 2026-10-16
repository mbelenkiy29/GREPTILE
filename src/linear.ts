import { createHash } from "node:crypto";
import { assertEgress } from "./egress";
import { z } from "zod";

const endpoint="https://api.linear.app";
const id=z.string().min(1).max(200);
const tokenResponse=z.object({access_token:z.string().min(10),refresh_token:z.string().min(10),token_type:z.literal("Bearer"),expires_in:z.number().int().positive().max(86400),scope:z.union([z.string(),z.array(z.string())])});
export const linearCredentials=z.object({accessToken:z.string().min(10),refreshToken:z.string().min(10),expiresAt:z.number().finite().positive()});
export type LinearCredentials=z.infer<typeof linearCredentials>;
export class LinearError extends Error {constructor(message:string,readonly status:number){super(message);}}

export function linearAuthorization(clientId:string,redirectUri:string,state:string,verifier:string){
 if(!clientId||!/^[a-zA-Z0-9_-]{32,128}$/.test(state)||!/^[a-zA-Z0-9_-]{43,128}$/.test(verifier))throw new Error("Invalid Linear OAuth parameters");
 const redirect=new URL(redirectUri);
 if(redirect.username||redirect.password||redirect.search||redirect.hash||!(redirect.protocol==="https:"||redirect.protocol==="http:"&&["localhost","127.0.0.1"].includes(redirect.hostname)))throw new Error("Linear callback requires HTTPS or local development");
 return "https://linear.app/oauth/authorize?"+new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:"code",scope:"read",state,prompt:"consent",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
}
export async function linearToken(clientId:string,grant:{code:string;verifier:string;redirectUri:string}|{refreshToken:string}):Promise<LinearCredentials>{
 if(!clientId)throw new Error("Configure LINEAR_CLIENT_ID");
 const body:Record<string,string>="code" in grant?{grant_type:"authorization_code",code:grant.code,code_verifier:grant.verifier,redirect_uri:grant.redirectUri}:{grant_type:"refresh_token",refresh_token:grant.refreshToken};
 assertEgress("integrations","Linear");const response=await fetch(endpoint+"/oauth/token",{method:"POST",redirect:"error",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...body,client_id:clientId}),signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new LinearError("Linear token request failed ("+response.status+")",response.status);
 const value=tokenResponse.parse(await response.json()),scopes=typeof value.scope==="string"?value.scope.split(/[ ,]+/).filter(Boolean):value.scope;
 if(scopes.length!==1||scopes[0]!=="read"){await revokeLinear({accessToken:value.access_token,refreshToken:value.refresh_token,expiresAt:Date.now()+value.expires_in*1000});throw new Error("Linear authorization must grant only read scope");}
 return {accessToken:value.access_token,refreshToken:value.refresh_token,expiresAt:Date.now()+value.expires_in*1000};
}
export async function revokeLinear(credentials:LinearCredentials){
 for(const [hint,token] of [["refresh_token",credentials.refreshToken],["access_token",credentials.accessToken]]){
  assertEgress("integrations","Linear");const response=await fetch(endpoint+"/oauth/revoke",{method:"POST",redirect:"error",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token,token_type_hint:hint}),signal:AbortSignal.timeout(30000)});
  if(![200,400,401].includes(response.status))throw new LinearError("Linear revocation failed ("+response.status+")",response.status);
 }
}
const identitySchema=z.object({organization:z.object({id,name:z.string(),urlKey:z.string()}),viewer:z.object({id})});
const resource=z.object({id,name:z.string()});
const pageInfo=z.object({hasNextPage:z.boolean(),endCursor:z.string().nullable()});
const issueIdentity=z.object({id,identifier:z.string(),team:z.object({id}),project:z.object({id}).nullable()});
const issueSchema=issueIdentity.extend({title:z.string().max(2000),description:z.string().max(100000).nullable(),updatedAt:z.string().datetime(),url:z.string().url().refine(value=>{const u=new URL(value);return u.origin==="https://linear.app"&&!u.username&&!u.password&&!u.search&&!u.hash;},"Invalid Linear source URL")});

export class Linear {
 constructor(private accessToken:string){if(!accessToken)throw new Error("Linear access token required");}
 private async query<T>(query:string,variables:Record<string,unknown>,schema:z.ZodType<T>):Promise<T>{
  assertEgress("integrations","Linear");const response=await fetch(endpoint+"/graphql",{method:"POST",redirect:"error",headers:{authorization:"Bearer "+this.accessToken,"content-type":"application/json"},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new LinearError("Linear API request failed ("+response.status+")",response.status);
  const result=z.object({data:z.unknown().optional(),errors:z.array(z.unknown()).optional()}).parse(await response.json());
  if(result.errors?.length)throw new LinearError("Linear GraphQL returned incomplete data",response.status);
  return schema.parse(result.data);
 }
 identity(){return this.query("query OpenReviewIdentity { organization { id name urlKey } viewer { id } }",{},identitySchema);}
 async resources(){
  const teams:({id:string;name:string;key:string})[]=[],projects:({id:string;name:string})[]=[];
  for(const kind of ["teams","projects"] as const){
   let after:string|null=null;
   // ponytail: discovery stops visibly after 2,000 resources of each kind; add UI pagination if needed.
   for(let page=0;page<20;page++){
    const result:{nodes:{id:string;name:string;key?:string}[];pageInfo:{hasNextPage:boolean;endCursor:string|null}}=await this.query(`query OpenReviewResources($after: String) { ${kind}(first: 100, after: $after) { nodes { id name ${kind==="teams"?"key":""} } pageInfo { hasNextPage endCursor } } }`,{after},z.object({[kind]:z.object({nodes:z.array(kind==="teams"?resource.extend({key:z.string()}):resource).max(100),pageInfo})})).then(r=>r[kind]);
    if(kind==="teams")teams.push(...result.nodes.map(n=>({...n,key:z.string().parse(n.key)})));else projects.push(...result.nodes);
    if(!result.pageInfo.hasNextPage)break;
    if(!result.pageInfo.endCursor||result.pageInfo.endCursor===after||page===19)throw new Error("Linear resource pagination incomplete");
    after=result.pageInfo.endCursor;
   }
  }
  return {teams,projects};
 }
 async issue(identifier:string,scope:{organizationId:string;teamIds:string[];projectIds:string[]}){
  if(!/^[A-Z0-9][A-Z0-9_]{0,49}-[1-9]\d{0,9}$/.test(identifier)||!scope.teamIds.length)throw new Error("Select Linear teams and use a valid issue identifier");
  // Read only identity first: out-of-scope issue descriptions must never reach retrieval or a model.
  const initial=await this.query("query OpenReviewIssueScope($id: String!) { organization { id } issue(id: $id) { id identifier team { id } project { id } } }",{id:identifier},z.object({organization:z.object({id}),issue:issueIdentity}));
  const permitted=(issue:z.infer<typeof issueIdentity>,organization:string)=>organization===scope.organizationId&&issue.identifier===identifier&&scope.teamIds.includes(issue.team.id)&&(!scope.projectIds.length||Boolean(issue.project&&scope.projectIds.includes(issue.project.id)));
  if(!permitted(initial.issue,initial.organization.id))throw new Error("Linear issue is outside the selected resources");
  const result=await this.query("query OpenReviewIssue($id: String!) { organization { id } issue(id: $id) { id identifier title description updatedAt url team { id } project { id } } }",{id:initial.issue.id},z.object({organization:z.object({id}),issue:issueSchema}));
  if(result.issue.id!==initial.issue.id||!permitted(result.issue,result.organization.id))throw new Error("Linear issue moved outside the selected resources");
  if(!new URL(result.issue.url).pathname.split("/").includes(identifier))throw new Error("Linear source URL does not match the fetched issue");
  return result.issue;
 }
}
