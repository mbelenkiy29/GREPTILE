import {v,type Infer} from "convex/values";
const identityRef=v.object({id:v.id("p4Identities"),generation:v.number()});
const sourceRef=v.object({repositoryId:v.id("repositories"),revision:v.string(),connectionId:v.optional(v.id("providerConnections")),credentialDigest:v.optional(v.string()),installationId:v.optional(v.number()),externalId:v.optional(v.string()),fullName:v.string(),instance:v.optional(v.string()),kind:v.optional(v.string()),baselineJobId:v.optional(v.id("indexJobs")),identity:v.optional(identityRef),providerIdentity:v.optional(v.object({id:v.id("providerIdentities"),generation:v.number(),externalId:v.string()})),paths:v.optional(v.array(v.string()))});
export const repositoryContextValidator=v.object({repositoryId:v.id("repositories"),userId:v.id("users"),actor:v.string(),githubActorId:v.optional(v.string()),nativeActor:v.optional(identityRef),providerActor:v.optional(v.object({id:v.id("providerIdentities"),generation:v.number(),externalId:v.string()})),clusters:v.array(v.object({id:v.id("repositoryClusters"),repositoryIds:v.array(v.id("repositories"))})),sources:v.array(sourceRef)});
export type RepositoryContext=Infer<typeof repositoryContextValidator>;

