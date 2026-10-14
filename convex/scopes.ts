import { mutation, query, internalQuery } from "./_generated/server";
import {repositoryIdentity} from "./repositoryIdentity";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { authorize, authorizeRepository, visibleRepositories, repositoryAccess, audit } from "./auth";
import { settingsValidator } from "./schema";
import { defaults,validSummarySections,validReviewEngine,validCheckFailureSeverity,scopeDefaults } from "../src/review-settings";
const keys=Object.keys(defaults);
export async function providerTeam(ctx:MutationCtx,organizationId:Id<"organizations">,kind:string,instance:string,group:{externalId:string;name:string},userId:Id<"users">){
 if(!group.externalId.trim()||group.externalId.length>200||!group.name.trim()||group.name.length>100)throw new Error("Invalid provider group identity");
 const url=new URL(instance);
 if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new Error("Invalid provider group instance");
 const origin=url.origin+url.pathname.replace(/\/$/,"");
 const externalKey=JSON.stringify([kind,origin,group.externalId]);
 const old=(await ctx.db.query("teams").withIndex("by_org",q=>q.eq("organizationId",organizationId)).collect()).find(t=>t.externalKey===externalKey);
 if(old)return old._id;
 const id=await ctx.db.insert("teams",{organizationId,name:group.name.trim(),externalKey,createdAt:Date.now()});
 await audit(ctx,organizationId,userId,"team.provider_group_connected",id);return id;
}
function resolveSettings(repo:Doc<"repositories">,scopes:Doc<"scopeSettings">[],local:Doc<"repositorySettings">|null) {
 const value=scopeDefaults(scopes,repo.teamId);
 return local&&!local.inherit?{...value,...local.settings}:value;
}
export async function effectiveSettings(ctx:QueryCtx|MutationCtx,repo:Doc<"repositories">) {
 const scopes=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect();
 const local=await ctx.db.query("repositorySettings").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).unique();
 return resolveSettings(repo,scopes,local);
}
export const list=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 const identity=await authorize(ctx,a.token,a.organizationId);const repositories=await visibleRepositories(ctx,a.token,a.organizationId);
 const teams=await ctx.db.query("teams").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const members=await Promise.all(teams.map(async t=>({teamId:t._id,members:await ctx.db.query("teamMembers").withIndex("by_team",q=>q.eq("teamId",t._id)).collect()})));
 const admin=["owner","admin"].includes(identity.member.role);const allowed=new Set(members.filter(m=>admin||m.members.some(p=>p.userId===identity.user._id)).map(m=>String(m.teamId)));
 const settings=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const clusters=await ctx.db.query("repositoryClusters").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();const repoIds=new Set(repositories.map(r=>String(r._id)));
 const configuredRepositories=await Promise.all(repositories.map(async repo=>{
  const local=await ctx.db.query("repositorySettings").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).unique();
  return {...repo,provider:await repositoryIdentity(ctx,repo),settingsInheritance:{mode:local&&!local.inherit?"overrides" as const:"inherited" as const,effective:resolveSettings(repo,settings,local)}};
 }));
 return {teams:teams.filter(t=>allowed.has(t._id)),members:members.filter(m=>allowed.has(m.teamId)),settings:settings.filter(s=>!s.teamId||allowed.has(s.teamId)),clusters:clusters.filter(c=>c.repositoryIds.every(id=>repoIds.has(id))),repositories:configuredRepositories};
}});
export const createTeam=mutation({args:{token:v.string(),organizationId:v.id("organizations"),name:v.string()},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);if(!a.name.trim()||a.name.length>100)throw new Error("Team name must be 1–100 characters");const id=await ctx.db.insert("teams",{organizationId:a.organizationId,name:a.name.trim(),createdAt:Date.now()});await audit(ctx,a.organizationId,user._id,"team.created",id);return id;
}});
export const assign=mutation({args:{token:v.string(),repositoryId:v.id("repositories"),teamId:v.optional(v.id("teams"))},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true,true);if(a.teamId&&(await ctx.db.get(a.teamId))?.organizationId!==repo.organizationId)throw new Error("Team belongs to another workspace");await ctx.db.patch(repo._id,{teamId:a.teamId});await audit(ctx,repo.organizationId,user._id,"repository.team_changed",repo._id);
}});
export const member=mutation({args:{token:v.string(),teamId:v.id("teams"),userId:v.id("users"),role:v.union(v.literal("admin"),v.literal("member"),v.literal("viewer")),remove:v.boolean()},handler:async(ctx,a)=>{
 const t=await ctx.db.get(a.teamId);if(!t)throw new Error("Team not found");const {user,member}=await authorize(ctx,a.token,t.organizationId);const self=await ctx.db.query("teamMembers").withIndex("by_team_user",q=>q.eq("teamId",t._id).eq("userId",user._id)).unique();if(!["owner","admin"].includes(member.role)&&self?.role!=="admin")throw new Error("Team admin required");
 const orgMember=await ctx.db.query("organizationMembers").withIndex("by_org_user",q=>q.eq("organizationId",t.organizationId).eq("userId",a.userId)).unique();if(!orgMember)throw new Error("Invite this user to the organization first");
 const old=await ctx.db.query("teamMembers").withIndex("by_team_user",q=>q.eq("teamId",t._id).eq("userId",a.userId)).unique();if(a.remove&&old)await ctx.db.delete(old._id);else if(!a.remove){if(old)await ctx.db.patch(old._id,{role:a.role});else await ctx.db.insert("teamMembers",{organizationId:t.organizationId,teamId:t._id,userId:a.userId,role:a.role});}await audit(ctx,t.organizationId,user._id,"team.member_changed",t._id);
}});
export const save=mutation({args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),settings:settingsValidator,overrideKeys:v.array(v.string())},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);if(a.teamId&&(await ctx.db.get(a.teamId))?.organizationId!==a.organizationId)throw new Error("Team not accessible");
 const s=a.settings;if(a.overrideKeys.some(k=>!keys.includes(k))||!validSummarySections(s.summarySections)||!validReviewEngine(s.reviewEngine)||!validCheckFailureSeverity(s.checkFailureSeverity)||s.maxComments<0||s.maxComments>30||!Number.isInteger(s.maxComments)||!Number.isFinite(s.minimumConfidence)||s.minimumConfidence<.5||s.minimumConfidence>1||!["concise","detailed"].includes(s.commentStyle)||s.instructions.length>20000||!["fast","standard","deep"].includes(s.mode)||!["critical","high","medium","low"].includes(s.severityThreshold)||s.categories.some(c=>!defaults.categories.includes(c)))throw new Error("Invalid settings");
 const scopes=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();const old=scopes.find(s=>s.teamId===a.teamId);const data={organizationId:a.organizationId,teamId:a.teamId,settings:s,overrideKeys:a.overrideKeys};if(old)await ctx.db.patch(old._id,data);else await ctx.db.insert("scopeSettings",data);await audit(ctx,a.organizationId,user._id,"settings.updated",a.teamId??a.organizationId);
}});
export const inherit=mutation({args:{token:v.string(),repositoryId:v.id("repositories")},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true,true);const s=await ctx.db.query("repositorySettings").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).unique();if(s)await ctx.db.patch(s._id,{inherit:true});await audit(ctx,repo.organizationId,user._id,"settings.inherited",repo._id);
}});
export const cluster=mutation({args:{token:v.string(),organizationId:v.id("organizations"),id:v.optional(v.id("repositoryClusters")),name:v.string(),repositoryIds:v.array(v.id("repositories")),remove:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);const old=a.id?await ctx.db.get(a.id):null;if(a.id&&old?.organizationId!==a.organizationId)throw new Error("Cluster not accessible");if(a.remove&&old){await ctx.db.delete(old._id);await audit(ctx,a.organizationId,user._id,"cluster.deleted",old._id);return;}
 if(!a.name.trim()||a.name.length>100||new Set(a.repositoryIds).size!==a.repositoryIds.length||a.repositoryIds.length<2||a.repositoryIds.length>20)throw new Error("Choose 2–20 distinct repositories and a name");
 for(const id of a.repositoryIds)if((await authorizeRepository(ctx,a.token,id)).repo.organizationId!==a.organizationId)throw new Error("Repository belongs to another workspace");const data={organizationId:a.organizationId,name:a.name,repositoryIds:a.repositoryIds};if(old)await ctx.db.patch(old._id,data);else await ctx.db.insert("repositoryClusters",{...data,createdAt:Date.now()});await audit(ctx,a.organizationId,user._id,"cluster.updated",a.name);
}});
export const related=internalQuery({args:{repositoryId:v.id("repositories"),actor:v.string()},handler:async(ctx,a)=>{
 const repo=await ctx.db.get(a.repositoryId);if(!repo)return[];const clusters=await ctx.db.query("repositoryClusters").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect();const ids=[...new Set(clusters.filter(c=>c.repositoryIds.includes(repo._id)).flatMap(c=>c.repositoryIds))].filter(id=>id!==repo._id);
 const members=await ctx.db.query("organizationMembers").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect();let actor:typeof members[number]|undefined;
 for(const m of members){const u=await ctx.db.get(m.userId);if(u?.login===a.actor){actor=m;break;}}
 // Cross-repository source is never shared with an unlinked review author.
 if(!actor)return[];
 try {await repositoryAccess(ctx,actor.userId,repo._id);}catch{return[];}
 const approved=new Set<string>();
 for(const cluster of clusters.filter(c=>c.repositoryIds.includes(repo._id))){
  let accessible=true;
  for(const id of cluster.repositoryIds){try{await repositoryAccess(ctx,actor.userId,id);}catch{accessible=false;break;}}
  if(accessible)cluster.repositoryIds.forEach(id=>approved.add(id));
 }
 const repos:Doc<"repositories">[]=[];for(const id of ids.filter(id=>approved.has(id))){const r=await ctx.db.get(id);if(!r?.indexedSha||r.organizationId!==repo.organizationId)continue;if(r.teamId&&!["owner","admin"].includes(actor.role)&&!await ctx.db.query("teamMembers").withIndex("by_team_user",q=>q.eq("teamId",r.teamId!).eq("userId",actor!.userId)).unique())continue;repos.push(r);}return repos;
}});
export const activity=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId,true);
 const entries=await ctx.db.query("auditEvents").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).order("desc").take(100);
 return Promise.all(entries.map(async entry=>({...entry,actor:entry.userId?(await ctx.db.get(entry.userId))?.login??"Unavailable user":"OpenReview"})));
}});
export const activityPage=query({args:{token:v.string(),organizationId:v.id("organizations"),cursor:v.optional(v.string())},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId,true);
 const result=await ctx.db.query("auditEvents").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).order("desc").paginate({numItems:30,cursor:a.cursor??null});
 const page=await Promise.all(result.page.map(async entry=>({...entry,actor:entry.userId?(await ctx.db.get(entry.userId))?.login??"Unavailable user":"OpenReview"})));
 return {...result,page};
}});
