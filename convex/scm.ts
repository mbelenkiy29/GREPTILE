"use node";
import type { ActionCtx } from "./_generated/server";
import { AzureDevOps } from "../src/azure-devops";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {githubEnterpriseEndpoints} from "../src/github-enterprise";
import { Github } from "../src/github";
import { Gitea } from "../src/gitea";
import { BitbucketDC } from "../src/bitbucket-dc";
import {BitbucketCloud,bitbucketCredential} from "../src/bitbucket-cloud";
import {forgeRepositories} from "../src/bitbucket-forge";
import { Origin } from "../src/origin";
import { Gitlab, type Scm } from "../src/gitlab";
import { decryptCredential, providerOrigin } from "../src/credentials";
import { z } from "zod";
export async function provider(ctx:ActionCtx,repo:Doc<"repositories">):Promise<Scm>{
 if(!repo.connectionId){if(!repo.installationId)throw new Error("Repository provider missing");return Github.installation(repo.installationId);}
 const c=await ctx.runQuery(internal.providerConnections.data,{id:repo.connectionId});
 const credentials=decryptCredential(c.credentials,c.organizationId+":"+c.kind);
 if(c.kind==="bitbucket-cloud"){const token=bitbucketCredential(credentials);if(!c.namespaceId||!repo.externalId)throw new Error("Bitbucket installation repository identity missing");return new BitbucketCloud(token.systemToken,c.namespaceId,repo.externalId,token.publisherId);}
 if(c.kind==="origin")return new Origin(JSON.parse(credentials),repo.externalId,async(repository,author)=>repository===repo.fullName&&await ctx.runAction(internal.providerIdentityJobs.originCanReply,{repositoryId:repo._id,authorExternalId:author}));
 const base=providerOrigin(c.instance,c.kind==="gitlab"?["gitlab.com"]:c.kind==="azure-devops"?["dev.azure.com"]:[]);
 if(c.kind==="gitea")return new Gitea(base,credentials);
 if(c.kind==="azure-devops")return new AzureDevOps(base,credentials,repo.externalId);
 if(c.kind==="bitbucket-dc"){const config=z.object({token:z.string().min(10),username:z.string().min(1)}).parse(JSON.parse(credentials));return new BitbucketDC(base,config.token,repo.externalId,config.username);}
 if(c.kind==="gitlab")return new Gitlab(base,credentials,repo.externalId);
 if(c.kind==="github-enterprise"){
  const config=z.object({appId:z.string(),privateKey:z.string(),installationId:z.number().int().positive()}).parse(JSON.parse(credentials));
  return Github.installation(config.installationId,{appId:config.appId,privateKey:config.privateKey,base:githubEnterpriseEndpoints(c.instance).api});
 }
 throw new Error("Provider adapter unavailable: "+c.kind);
}
export async function discover(c:Doc<"providerConnections">){
 const token=decryptCredential(c.credentials,c.organizationId+":"+c.kind);
 if(c.kind==="bitbucket-cloud"){
  const credential=bitbucketCredential(token);if(!c.namespaceId)throw new Error("Bitbucket installation workspace identity missing");
  return (await forgeRepositories(c.namespaceId,credential.systemToken)).map(r=>({...r,defaultBranch:r.defaultBranch??""}));
 }
 if(c.kind==="origin")return new Origin(JSON.parse(token)).repositories();
 const base=providerOrigin(c.instance,c.kind==="gitlab"?["gitlab.com"]:c.kind==="azure-devops"?["dev.azure.com"]:[]);
 if(c.kind==="gitlab")return new Gitlab(base,token).repositories();
 if(c.kind==="gitea")return new Gitea(base,token).discover();
 if(c.kind==="azure-devops")return new AzureDevOps(base,token).repositories();
 if(c.kind==="bitbucket-dc"){const config=z.object({token:z.string().min(10),username:z.string().min(1)}).parse(JSON.parse(token));return new BitbucketDC(base,config.token,undefined,config.username).repositories();}
 if(c.kind==="github-enterprise"){
  const config=z.object({appId:z.string(),privateKey:z.string(),installationId:z.number().int().positive()}).parse(JSON.parse(token));
  const repos=await (await Github.installation(config.installationId,{appId:config.appId,privateKey:config.privateKey,base:githubEnterpriseEndpoints(c.instance).api})).repositories();
  return repos.map(r=>({externalId:String(r.id),fullName:r.full_name,defaultBranch:r.default_branch,remoteUrl:githubEnterpriseEndpoints(c.instance).web+"/"+r.full_name+".git",...(r.owner.type==="Organization"&&r.owner.id?{group:{externalId:String(r.owner.id),name:r.owner.login.slice(0,100)}}:{})}));
 }
 throw new Error("Provider discovery unavailable");
}
