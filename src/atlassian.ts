import { z } from "zod";
import { assertEgress } from "./egress";

export const atlassianScopes = ["offline_access", "read:jira-work", "read:page:confluence", "read:space:confluence"];
const cloudId = z.string().uuid();
const nativeId = z.string().regex(/^[1-9]\d{0,19}$/);
const siteUrl = z.string().url().refine(value => {
  const u = new URL(value);
  return u.protocol === "https:" && u.hostname.endsWith(".atlassian.net") && !u.username && !u.password && !u.search && !u.hash && ["", "/"].includes(u.pathname);
});
const siteSchema = z.object({id:cloudId,name:z.string().min(1).max(200),url:siteUrl,scopes:z.array(z.string())});
export type AtlassianSite = z.infer<typeof siteSchema>;
export const atlassianCredentials = z.object({accessToken:z.string().min(10),refreshToken:z.string().min(10),expiresAt:z.number().finite().positive()});
export type AtlassianCredentials = z.infer<typeof atlassianCredentials>;
export class AtlassianError extends Error {constructor(message:string,readonly status:number){super(message);}}
function callback(value:string) {
  const u = new URL(value);
  if(u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || u.protocol === "http:" && ["localhost","127.0.0.1"].includes(u.hostname))) throw new Error("Atlassian callback requires HTTPS or local development");
  return value;
}
export function atlassianAuthorization(clientId:string,redirectUri:string,state:string) {
  if(!clientId || !/^[a-zA-Z0-9_-]{32,128}$/.test(state)) throw new Error("Invalid Atlassian OAuth parameters");
  return "https://auth.atlassian.com/authorize?" + new URLSearchParams({audience:"api.atlassian.com",client_id:clientId,redirect_uri:callback(redirectUri),state,response_type:"code",prompt:"consent",scope:atlassianScopes.join(" ")});
}
export async function atlassianToken(clientId:string,clientSecret:string,grant:{code:string;redirectUri:string}|{refreshToken:string}):Promise<AtlassianCredentials> {
  if(!clientId || !clientSecret) throw new Error("Configure ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET");
  const body = "code" in grant ? {grant_type:"authorization_code",code:grant.code,redirect_uri:callback(grant.redirectUri)} : {grant_type:"refresh_token",refresh_token:grant.refreshToken};
  assertEgress("integrations", "Atlassian");
  const response = await fetch("https://auth.atlassian.com/oauth/token",{method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify({...body,client_id:clientId,client_secret:clientSecret}),signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new AtlassianError("Atlassian token request failed ("+response.status+")",response.status);
  const result = z.object({access_token:z.string().min(10),refresh_token:z.string().min(10),expires_in:z.number().int().positive().max(86400),scope:z.string()}).parse(await response.json());
  const granted = result.scope.split(/\s+/).filter(Boolean);
  if(granted.some(s=>!atlassianScopes.includes(s)) || atlassianScopes.filter(s=>s!=="offline_access").some(s=>!granted.includes(s))) throw new Error("Atlassian authorization must grant exactly the configured read-only scopes");
  return {accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:Date.now()+result.expires_in*1000};
}
const documentSchema = z.object({type:z.literal("doc"),version:z.literal(1),content:z.array(z.unknown()).optional()}).passthrough();
function documentContent(value:unknown):string {
  const text = value === null ? "" : JSON.stringify(documentSchema.parse(value));
  if(Buffer.byteLength(text,"utf8")>100000) throw new Error("Atlassian document exceeds 100KB context limit");
  return text;
}
const issueIdentity = z.object({id:nativeId,key:z.string(),fields:z.object({project:z.object({id:nativeId})})});
const pageIdentity = z.object({id:nativeId,spaceId:nativeId,status:z.literal("current")});
export class Atlassian {
  constructor(private accessToken:string){if(!accessToken) throw new Error("Atlassian access token required");}
  private async get<T>(path:string,schema:z.ZodType<T>):Promise<T> {
    if(!path.startsWith("/")) throw new Error("Invalid Atlassian API path");
    assertEgress("integrations","Atlassian");const response=await fetch("https://api.atlassian.com"+path,{redirect:"error",headers:{authorization:"Bearer "+this.accessToken,accept:"application/json"},signal:AbortSignal.timeout(30000)});
    if(!response.ok) throw new AtlassianError("Atlassian API request failed ("+response.status+")",response.status);
    const text = await response.text();
    if(Buffer.byteLength(text,"utf8")>2000000) throw new Error("Atlassian response exceeds 2MB retrieval limit");
    return schema.parse(JSON.parse(text));
  }
  sites(){return this.get("/oauth/token/accessible-resources",z.array(siteSchema).max(100));}
  private async site(site:AtlassianSite,required:string) {
    siteSchema.parse(site);
    const current=(await this.sites()).find(s=>s.id===site.id && s.url===site.url && s.scopes.includes(required));
    if(!current) throw new Error("Atlassian site is no longer authorized");
    return current;
  }
  async resources(site:AtlassianSite) {
    const projects:{id:string;name:string;key:string}[]=[],spaces:{id:string;name:string;key:string}[]=[];
    // ponytail: discovery fails visibly beyond 2,000 projects/spaces; add UI paging if needed.
    if(site.scopes.includes("read:jira-work")) {
      await this.site(site,"read:jira-work");
      let startAt=0;
      for(let page=0;page<20;page++) {
        const result=await this.get(`/ex/jira/${site.id}/rest/api/3/project/search?maxResults=100&startAt=${startAt}`,z.object({startAt:z.number().int().nonnegative(),isLast:z.boolean(),values:z.array(z.object({id:nativeId,key:z.string(),name:z.string()})).max(100)}));
        if(result.startAt!==startAt) throw new Error("Jira project pagination changed");
        projects.push(...result.values);
        if(result.isLast) break;
        if(!result.values.length || page===19) throw new Error("Jira project pagination incomplete");
        startAt+=result.values.length;
      }
    }
    if(site.scopes.includes("read:space:confluence")) {
      await this.site(site,"read:space:confluence");
      let query="limit=100";
      for(let page=0;page<20;page++) {
        const result=await this.get(`/ex/confluence/${site.id}/wiki/api/v2/spaces?${query}`,z.object({results:z.array(z.object({id:nativeId,key:z.string(),name:z.string()})).max(100),_links:z.object({next:z.string().optional()})}));
        spaces.push(...result.results);
        if(!result._links.next) break;
        const next=new URL(result._links.next,"https://api.atlassian.com");
        if(next.origin!=="https://api.atlassian.com" || !["/wiki/api/v2/spaces",`/ex/confluence/${site.id}/wiki/api/v2/spaces`].includes(next.pathname) || !next.searchParams.get("cursor") || next.searchParams.get("cursor")==new URLSearchParams(query).get("cursor") || page===19) throw new Error("Confluence space pagination incomplete");
        query=new URLSearchParams({limit:"100",cursor:next.searchParams.get("cursor")!}).toString();
      }
    }
    return {projects,spaces};
  }
  async issue(site:AtlassianSite,key:string,projectIds:string[]) {
    if(!/^[A-Z][A-Z0-9_]{0,49}-[1-9]\d{0,19}$/.test(key) || !projectIds.length) throw new Error("Select Jira projects and use a valid issue key");
    await this.site(site,"read:jira-work");
    const path=`/ex/jira/${site.id}/rest/api/3/issue/`;
    const initial=await this.get(path+encodeURIComponent(key)+"?fields=project",issueIdentity);
    if(initial.key!==key || !projectIds.includes(initial.fields.project.id)) throw new Error("Jira issue is outside selected projects");
    const issue=await this.get(path+initial.id+"?fields=project,summary,description,updated",issueIdentity.extend({fields:issueIdentity.shape.fields.extend({summary:z.string().max(2000),description:documentSchema.nullable(),updated:z.string().datetime({offset:true})})}));
    if(issue.id!==initial.id || issue.key!==key || !projectIds.includes(issue.fields.project.id)) throw new Error("Jira issue moved outside selected projects");
    return {id:issue.id,key,title:issue.fields.summary,description:documentContent(issue.fields.description),revision:issue.fields.updated,url:new URL("/browse/"+key,site.url).href};
  }
  async page(site:AtlassianSite,id:string,spaceIds:string[]) {
    nativeId.parse(id);if(!spaceIds.length) throw new Error("Select Confluence spaces");
    await this.site(site,"read:page:confluence");
    const path=`/ex/confluence/${site.id}/wiki/api/v2/pages/${id}`;
    const initial=await this.get(path,pageIdentity);
    if(initial.id!==id || !spaceIds.includes(initial.spaceId)) throw new Error("Confluence page is outside selected spaces");
    const page=await this.get(path+"?body-format=atlas_doc_format",pageIdentity.extend({title:z.string().max(2000),version:z.object({number:z.number().int().positive()}),body:z.object({atlas_doc_format:z.object({value:z.string().max(100000),representation:z.literal("atlas_doc_format")})})}));
    if(page.id!==id || !spaceIds.includes(page.spaceId)) throw new Error("Confluence page moved outside selected spaces");
    // Keep native ADF as data: no rendering HTML, scripts, or embedded assets.
    const description=documentContent(JSON.parse(page.body.atlas_doc_format.value));
    return {id,title:page.title,description,revision:String(page.version.number),url:new URL(`/wiki/pages/viewpage.action?pageId=${id}`,site.url).href};
  }
}
