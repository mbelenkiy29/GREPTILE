"use node";
import {action,internalAction} from './_generated/server';
import {internal} from './_generated/api';
import {v} from 'convex/values';
import type {Id} from './_generated/dataModel';
import {authenticatedProviderIdentity} from '../src/provider-identity';
import {connectionNetwork} from '../src/scm-transport';
import {encryptCredential} from '../src/credentials';
import {service} from './auth';
import {decryptCredential} from '../src/credentials';
import {originCredentials,originPersonalIdentity,verifyOriginUserReceipt,originUserAccess,originUserCanReply} from '../src/origin-auth';
import {providerIdentityDigest} from './providerIdentities';
export const connect=action({args:{token:v.string(),repositoryId:v.id('repositories'),personalToken:v.string()},handler:async(ctx,a):Promise<Id<'providerIdentities'>>=>{
 const state=await ctx.runQuery(internal.providerIdentities.authorize,{token:a.token,repositoryId:a.repositoryId}),identity=await authenticatedProviderIdentity(state.connection.kind,state.connection.instance,a.personalToken,connectionNetwork(state.connection));
 return ctx.runMutation(internal.providerIdentities.save,{token:a.token,repositoryId:a.repositoryId,connectionId:state.connection._id,digest:await providerIdentityDigest(state.connection),...identity,credentials:encryptCredential(a.personalToken,state.repo.organizationId+':provider-personal:'+state.connection._id+':'+state.user._id)});
}});

export const connectOrigin=action({args:{token:v.string(),secret:v.string(),repositoryId:v.id('repositories'),receipt:v.string(),state:v.string(),digest:v.string()},handler:async(ctx,a):Promise<Id<'providerIdentities'>>=>{
 service(a.secret);if(a.receipt.length>20000)throw new Error('Origin confirmation too large');
 const s=await ctx.runQuery(internal.providerIdentities.authorize,{token:a.token,repositoryId:a.repositoryId}),c=s.connection;
 if(c.kind!=='origin'||await providerIdentityDigest(c)!==a.digest||!c.installationId||!c.namespaceId||!s.repo.externalId)throw new Error('Origin confirmation connection changed');
 const credentials=originCredentials.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+':origin')));
 if(credentials.installationId!==c.installationId)throw new Error('Origin installation changed');
 const r=await verifyOriginUserReceipt(a.receipt,credentials.appId,a.state,c.installationId,c.namespaceId),personal=originPersonalIdentity.parse({userId:r.sub,installationId:r.installation_id,namespaceId:r.namespace_id}),identity=await originUserAccess(credentials,personal,s.repo.externalId);
 return ctx.runMutation(internal.providerIdentities.save,{token:a.token,repositoryId:a.repositoryId,connectionId:c._id,digest:a.digest,...identity,credentials:encryptCredential(JSON.stringify(personal),s.repo.organizationId+':provider-personal:'+c._id+':'+s.user._id),originReceipt:{jti:r.jti,expiresAt:r.exp*1000,installationId:r.installation_id,namespaceId:r.namespace_id}});
}});

export const originCanReply=internalAction({args:{repositoryId:v.id('repositories'),authorExternalId:v.string()},handler:async(ctx,a):Promise<boolean>=>{
 const state=await ctx.runQuery(internal.providerIdentities.originAuthor,{repositoryId:a.repositoryId,externalId:a.authorExternalId});if(!state)return false;
 const c=state.connection,i=state.identity,personal=originPersonalIdentity.parse(JSON.parse(decryptCredential(i.credentials!,i.organizationId+':provider-personal:'+c._id+':'+i.userId))),credentials=originCredentials.parse(JSON.parse(decryptCredential(c.credentials,c.organizationId+':origin')));
 if(personal.userId!==a.authorExternalId)return false;
 if(!await originUserCanReply(credentials,personal,state.repo.externalId??''))return false;
 const after=await ctx.runQuery(internal.providerIdentities.originAuthor,{repositoryId:a.repositoryId,externalId:a.authorExternalId});return !!after&&after.identity._id===i._id&&after.identity.generation===i.generation&&after.identity.connectionDigest===i.connectionDigest;
}});
